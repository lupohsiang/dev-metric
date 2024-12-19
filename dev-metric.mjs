import { Octokit } from "@octokit/rest";
import { config } from "dotenv";
import fs from "fs/promises";
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween.js";
import vega from "vega";
import { compile } from "vega-lite";

// Initialize dotenv and dayjs plugins
config();
dayjs.extend(isBetween);

class GitHubStatsAnalyzer {
  constructor(token) {
    this.octokit = new Octokit({
      auth: token,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  }

  async getRepositoryStats(owner, repo, startDate, endDate) {
    try {
      // Get commit activity for the last year
      const commitActivity = await this.retryRequest(async () => {
        const response = await this.octokit.request(
          "GET /repos/{owner}/{repo}/stats/commit_activity",
          {
            owner,
            repo,
          }
        );
        return response.data;
      });

      // Get all PR statistics with pagination
      const pullRequests = await this.getAllPaginatedData(
        async (page) => {
          const response = await this.octokit.request(
            "GET /repos/{owner}/{repo}/pulls",
            {
              owner,
              repo,
              state: "all",
              sort: "created",
              direction: "desc",
              per_page: 100,
              page,
              labels: ["bug"]
            }
          );
          return response;
        },
        (pr) => dayjs(pr.created_at).isBetween(startDate, endDate, null, "[]")
      );

      // Get all deployment statistics with pagination
      const deployments = await this.getAllPaginatedData(
        async (page) => {
          const response = await this.octokit.request(
            "GET /repos/{owner}/{repo}/deployments",
            {
              owner,
              repo,
              per_page: 100,
              page,
            }
          );
          return response;
        },
        (deployment) =>
          dayjs(deployment.created_at).isBetween(startDate, endDate, null, "[]")
      );

      // Process and analyze the data
      const stats = this.processStats(
        commitActivity,
        pullRequests,
        deployments,
        startDate,
        endDate
      );
      return stats;
    } catch (error) {
      console.error("Error fetching repository statistics:", error.message);
      throw error;
    }
  }

  async getAllPaginatedData(requestFn, filterFn) {
    let page = 1;
    let allData = [];
    let hasNextPage = true;

    while (hasNextPage) {
      try {
        const response = await requestFn(page);
        const { data, headers } = response;

        if (data.length === 0) {
          break;
        }

        // Apply date filter
        const filteredData = filterFn ? data.filter(filterFn) : data;
        allData = allData.concat(filteredData);

        // Check if there's a next page using GitHub's Link header
        const linkHeader = headers.link;
        hasNextPage = linkHeader && linkHeader.includes('rel="next"');

        // If all items in current page are filtered out and there's no next page, break
        if (filteredData.length === 0 && !hasNextPage) {
          break;
        }

        page++;
      } catch (error) {
        console.error(`Error fetching page ${page}:`, error);
        break;
      }
    }

    return allData;
  }

  async retryRequest(requestFn, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await requestFn();
        if (response && Array.isArray(response)) return response;
        console.log(
          `Attempt ${i + 1}: Waiting for GitHub to compute statistics...`
        );
        await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
      } catch (error) {
        if (error.status === 202) {
          console.log(
            `Attempt ${i + 1}: GitHub is computing statistics (202 status)...`
          );
          await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
          continue;
        }
        throw error;
      }
    }
    console.log("Maximum retries reached, returning empty array");
    return [];
  }

  processStats(commitActivity, pullRequests, deployments, startDate, endDate) {
    // Add safety check for commitActivity
    if (!Array.isArray(commitActivity)) {
      console.log("Commit activity data:", commitActivity);
      commitActivity = []; // Provide a default empty array if data is invalid
    }

    // Calculate weekly commit frequency
    const weeklyCommits = commitActivity.map((week) => ({
      week: new Date(week.week * 1000).toISOString().split("T")[0],
      commits: week.total,
    }));

    // Process PRs by week
    const weeklyPRStats = {};
    pullRequests.forEach((pr) => {
      const weekStart = new Date(pr.created_at);
      weekStart.setUTCHours(0, 0, 0, 0);
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
      const weekKey = weekStart.toISOString().split("T")[0];

      if (!weeklyPRStats[weekKey]) {
        weeklyPRStats[weekKey] = {
          prCount: 0,
          mergedCount: 0,
          totalMergeTime: 0,
          bugPRCount: 0,
          mergedBugPRCount: 0
        };
      }

      weeklyPRStats[weekKey].prCount++;

      if (pr.labels.some(label => label.name === "bug")) {
        weeklyPRStats[weekKey].bugPRCount++;
        if (pr.merged_at) {
          weeklyPRStats[weekKey].mergedBugPRCount++;
        }
      }

      if (pr.merged_at) {
        weeklyPRStats[weekKey].mergedCount++;
        const mergeTime =
          (new Date(pr.merged_at) - new Date(pr.created_at)) / (1000 * 60 * 60); // Convert to hours
        weeklyPRStats[weekKey].totalMergeTime += mergeTime;
      }
    });

    // Convert weeklyPRStats to array format and calculate averages
    const weeklyPRMetrics = Object.entries(weeklyPRStats)
      .map(([week, stats]) => ({
        week,
        prCount: stats.prCount,
        mergedCount: stats.mergedCount,
        averageMergeTime:
          stats.mergedCount > 0
            ? (stats.totalMergeTime / stats.mergedCount).toFixed(2)
            : 0,
        bugPRCount: stats.bugPRCount,
        mergedBugPRCount: stats.mergedBugPRCount
      }))
      .sort((a, b) => a.week.localeCompare(b.week));

    // Calculate PR metrics
    const prMetrics = {
      totalPRs: pullRequests.length,
      mergedPRs: pullRequests.filter((pr) => pr.merged_at).length,
      averagePRsPerWeek: pullRequests.length / 52,
      prMergeRate: (
        (pullRequests.filter((pr) => pr.merged_at).length /
          pullRequests.length) *
        100
      ).toFixed(2),
    };

    // Calculate deployment frequency
    const deploymentMetrics = {
      totalDeployments: deployments.length,
      averageDeploymentsPerWeek: deployments.length / 52,
    };

    // Calculate time periods
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    const recentPRs = pullRequests.filter(
      (pr) => new Date(pr.created_at) > lastMonth
    );
    const recentDeployments = deployments.filter(
      (deploy) => new Date(deploy.created_at) > lastMonth
    );

    const stats = {
      commitStats: {
        totalCommitsLastYear: weeklyCommits.reduce(
          (sum, week) => sum + week.commits,
          0
        ),
        averageCommitsPerWeek: (
          weeklyCommits.reduce((sum, week) => sum + week.commits, 0) /
          weeklyCommits.length
        ).toFixed(2),
        weeklyCommitTrend: weeklyCommits,
      },
      prStats: {
        ...prMetrics,
        recentPRCount: recentPRs.length,
        recentPRsPerWeek: (recentPRs.length / 4).toFixed(2),
        weeklyMetrics: weeklyPRMetrics,
        bugPRs: {
          total: pullRequests.filter(pr => pr.labels.some(label => label.name === "bug")).length,
          merged: pullRequests.filter(pr => pr.merged_at && pr.labels.some(label => label.name === "bug")).length,
          weeklyMetrics: weeklyPRMetrics
        }
      },
      deploymentStats: {
        ...deploymentMetrics,
        recentDeploymentCount: recentDeployments.length,
        recentDeploymentsPerWeek: (recentDeployments.length / 4).toFixed(2),
      },
    };

    // Export detailed stats to JSON
    this.exportStatsToJson(stats, startDate, endDate);

    return stats;
  }

  async exportStatsToJson(stats, startDate, endDate) {
    try {
      // Ensure output directory exists
      await fs.mkdir("output", { recursive: true });

      // Export the full stats
      await fs.writeFile(
        `output/detailed-metrics-${startDate}-${endDate}.json`,
        JSON.stringify(stats, null, 2)
      );

      // Export weekly PR metrics separately for easier consumption
      const weeklyMetrics = {
        commits: stats.commitStats.weeklyCommitTrend,
        pullRequests: stats.prStats.weeklyMetrics,
      };
      await fs.writeFile(
        `output/weekly-metrics-${startDate}-${endDate}.json`,
        JSON.stringify(weeklyMetrics, null, 2)
      );
    } catch (error) {
      console.error("Error exporting stats to JSON:", error);
    }
  }

  async generateCharts(stats) {
    // PR Trends Chart Specification
    const prTrendsSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: 800,
      height: 400,
      data: { values: stats.prStats.weeklyMetrics },
      layer: [
        {
          mark: { type: "line", point: true },
          encoding: {
            x: { field: "week", type: "temporal", title: "Week" },
            y: { field: "prCount", type: "quantitative", title: "Count" },
            color: { 
              datum: "Total PRs",
              legend: { title: "PR Metrics" }
            },
            tooltip: [
              { field: "week", type: "temporal", title: "Week" },
              { field: "prCount", type: "quantitative", title: "Total PRs" },
              { field: "mergedCount", type: "quantitative", title: "Merged PRs" }
            ]
          }
        },
        {
          mark: { type: "line", point: true, strokeDash: [4, 4] },
          encoding: {
            x: { field: "week", type: "temporal" },
            y: { field: "mergedCount", type: "quantitative" },
            color: { 
              datum: "Merged PRs",
              legend: { title: "PR Metrics" }
            }
          }
        }
      ],
      title: "PR Creation and Merge Trends",
      config: {
        legend: {
          orient: "top-right",
          fillColor: "#FFFFFF",
          padding: 10,
          cornerRadius: 4,
          strokeWidth: 1
        }
      }
    };

    // Merge Time Chart Specification
    const mergeTimeSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: 800,
      height: 400,
      data: { values: stats.prStats.weeklyMetrics },
      mark: { 
        type: "line", 
        point: true,
        color: "#4C78A8"
      },
      encoding: {
        x: { field: "week", type: "temporal", title: "Week" },
        y: { 
          field: "averageMergeTime", 
          type: "quantitative", 
          title: "Average Time (hours)" 
        },
        tooltip: [
          { field: "week", type: "temporal", title: "Week" },
          { field: "averageMergeTime", type: "quantitative", title: "Average Merge Time (hours)" }
        ]
      },
      title: "Average PR Merge Time Trend"
    };

    // Commit Activity Chart Specification
    const commitSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: 800,
      height: 400,
      data: { values: stats.commitStats.weeklyCommitTrend },
      mark: { 
        type: "bar",
        color: "#4C78A8",
        tooltip: true
      },
      encoding: {
        x: { field: "week", type: "temporal", title: "Week" },
        y: { field: "commits", type: "quantitative", title: "Number of Commits" },
        tooltip: [
          { field: "week", type: "temporal", title: "Week" },
          { field: "commits", type: "quantitative", title: "Commits" }
        ]
      },
      title: "Weekly Commit Activity",
      config: {
        bar: {
          binSpacing: 1,
          cornerRadiusEnd: 4
        }
      }
    };

    // Bug PR Trend Chart Specification
    const bugPRTrendSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: 800,
      height: 400,
      data: { values: stats.prStats.bugPRs.weeklyMetrics },
      layer: [
        {
          mark: { type: "line", point: true },
          encoding: {
            x: { field: "week", type: "temporal", title: "Week" },
            y: { field: "bugPRCount", type: "quantitative", title: "Count" },
            color: { 
              datum: "Total Bug PRs",
              legend: { title: "Bug PR Metrics" }
            },
            tooltip: [
              { field: "week", type: "temporal", title: "Week" },
              { field: "bugPRCount", type: "quantitative", title: "Total Bug PRs" },
              { field: "mergedBugPRCount", type: "quantitative", title: "Merged Bug PRs" }
            ]
          }
        },
        {
          mark: { type: "line", point: true, strokeDash: [4, 4] },
          encoding: {
            x: { field: "week", type: "temporal" },
            y: { field: "mergedBugPRCount", type: "quantitative" },
            color: { 
              datum: "Merged Bug PRs",
              legend: { title: "Bug PR Metrics" }
            }
          }
        }
      ],
      title: "Bug PR Creation and Merge Trends",
      config: {
        legend: {
          orient: "top-right",
          fillColor: "#FFFFFF",
          padding: 10,
          cornerRadius: 4,
          strokeWidth: 1
        }
      }
    };

    try {
      // Create output/charts directory if it doesn't exist
      await fs.mkdir("output/charts", { recursive: true });

      // Generate and save each chart
      const specs = [
        { spec: prTrendsSpec, filename: "pr-trends.svg" },
        { spec: mergeTimeSpec, filename: "merge-time-trend.svg" },
        { spec: commitSpec, filename: "commit-activity.svg" },
        { spec: bugPRTrendSpec, filename: "bug-pr-trend.svg" }
      ];

      for (const { spec, filename } of specs) {
        // Compile Vega-Lite to Vega
        const vegaSpec = compile(spec).spec;
        
        // Create a new Vega View
        const view = new vega.View(vega.parse(vegaSpec))
          .renderer('none')
          .initialize();

        // Generate SVG
        const svg = await view.toSVG();
        await fs.writeFile(`output/charts/${filename}`, svg);
        
        // Clean up
        view.finalize();
      }

      console.log("Charts generated successfully in output/charts directory");
    } catch (error) {
      console.error("Error generating charts:", error);
    }
  }

  generateReport(stats) {
    return `
Development Efficiency Report

1. Commit Activity
   - Total commits in the last year: ${stats.commitStats.totalCommitsLastYear}
   - Average commits per week: ${stats.commitStats.averageCommitsPerWeek}

2. Pull Request Metrics
   - Total PRs: ${stats.prStats.totalPRs}
   - Merged PRs: ${stats.prStats.mergedPRs}
   - PR merge rate: ${stats.prStats.prMergeRate}%
   - Average PRs per week: ${stats.prStats.averagePRsPerWeek.toFixed(2)}
   - Recent PR frequency (last month): ${stats.prStats.recentPRsPerWeek} PRs/week

3. Bug PR Metrics
   - Total bug PRs: ${stats.prStats.bugPRs.total}
   - Merged bug PRs: ${stats.prStats.bugPRs.merged}
   - Bug PR merge rate: ${((stats.prStats.bugPRs.merged / stats.prStats.bugPRs.total) * 100).toFixed(2)}%

4. Deployment Metrics
   - Total deployments: ${stats.deploymentStats.totalDeployments}
   - Average deployments per week: ${stats.deploymentStats.averageDeploymentsPerWeek.toFixed(2)}
   - Recent deployment frequency (last month): ${stats.deploymentStats.recentDeploymentsPerWeek} deployments/week
`;
  }
}

// Example usage
async function main() {
  const token = process.env.GITHUB_TOKEN;
  const analyzer = new GitHubStatsAnalyzer(token);

  try {
    const startDate = process.env.START_DATE;
    const endDate = process.env.END_DATE;
    const stats = await analyzer.getRepositoryStats(
      process.env.GITHUB_OWNER,
      process.env.GITHUB_REPO,
      startDate,
      endDate
    );
    const report = analyzer.generateReport(stats);
    console.log(report);
    
    // Generate charts
    await analyzer.generateCharts(stats);
  } catch (error) {
    console.error("Error generating report:", error);
  }
}

main();
