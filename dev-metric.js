const { Octokit } = require("@octokit/rest");
const asana = require("asana");
const fs = require("fs/promises");
const path = require("path");
const dayjs = require("dayjs");
const isBetween = require("dayjs/plugin/isBetween");
const vega = require("vega");
require("dotenv").config();

// Add dayjs plugins
dayjs.extend(isBetween);

class DevMetricsAnalyzer {
  constructor(githubToken, asanaToken) {
    this.github = new Octokit({ auth: githubToken });
    this.asana = asana.Client.create().useAccessToken(asanaToken);
  }

  async collectData(repoOwner, repoName, asanaProjectId, startDate, endDate) {
    try {
      // Create output directory
      await fs.mkdir("output", { recursive: true });

      // Collect data
      const githubData = await this.getGitHubMetrics(
        repoOwner,
        repoName,
        startDate,
        endDate
      );
      const asanaData = await this.getAsanaMetrics(
        asanaProjectId,
        startDate,
        endDate
      );

      // Generate reports and charts
      await this.generateReport(githubData, asanaData);
      await this.generateCharts(githubData, asanaData);
    } catch (error) {
      console.error("Error in data collection:", error);
    }
  }

  async getGitHubMetrics(owner, repo, startDate, endDate) {
    const metrics = {
      prs: [],
      deployments: [],
      weeklyStats: {},
    };

    try {
      // Get PR data
      const { data: pullRequests } = await this.github.pulls.list({
        owner,
        repo,
        state: "all",
        sort: "created",
        direction: "desc",
        per_page: 100,
      });

      // Process PR data
      metrics.prs = pullRequests
        .filter((pr) => dayjs(pr.created_at).isBetween(startDate, endDate))
        .map((pr) => ({
          number: pr.number,
          createdAt: pr.created_at,
          mergedAt: pr.merged_at,
          reviewComments: pr.review_comments,
          additions: pr.additions,
          deletions: pr.deletions,
        }));

      // Weekly PR statistics
      metrics.weeklyStats = this.aggregateWeeklyStats(metrics.prs);
    } catch (error) {
      console.error("Error fetching GitHub metrics:", error);
    }

    return metrics;
  }

  async getAsanaMetrics(projectId, startDate, endDate) {
    const metrics = {
      tasks: [],
      bugs: [],
      weeklyStats: {},
    };

    try {
      const tasks = await this.asana.tasks.findByProject(projectId);

      for await (const task of tasks) {
        const taskDetail = await this.asana.tasks.findById(task.gid);
        if (
          taskDetail.completed_at &&
          dayjs(taskDetail.completed_at).isBetween(startDate, endDate)
        ) {
          const taskData = {
            name: taskDetail.name,
            createdAt: taskDetail.created_at,
            completedAt: taskDetail.completed_at,
            isBug: taskDetail.name.toLowerCase().includes("bug"),
          };

          if (taskData.isBug) {
            metrics.bugs.push(taskData);
          }
          metrics.tasks.push(taskData);
        }
      }

      // Weekly task and bug statistics
      metrics.weeklyStats = this.aggregateWeeklyTaskStats(metrics.tasks);
    } catch (error) {
      console.error("Error fetching Asana metrics:", error);
    }

    return metrics;
  }

  aggregateWeeklyStats(prs) {
    const weeklyStats = {};

    prs.forEach((pr) => {
      const week = dayjs(pr.createdAt).startOf("week").format("YYYY-MM-DD");
      if (!weeklyStats[week]) {
        weeklyStats[week] = { prCount: 0, reviewTime: 0 };
      }
      weeklyStats[week].prCount++;

      if (pr.mergedAt) {
        const reviewTime = dayjs(pr.mergedAt).diff(dayjs(pr.createdAt), "hour");
        weeklyStats[week].reviewTime += reviewTime;
      }
    });

    return weeklyStats;
  }

  aggregateWeeklyTaskStats(tasks) {
    const weeklyStats = {};

    tasks.forEach((task) => {
      const week = dayjs(task.completedAt).startOf("week").format("YYYY-MM-DD");
      if (!weeklyStats[week]) {
        weeklyStats[week] = { taskCount: 0, bugCount: 0 };
      }
      weeklyStats[week].taskCount++;
      if (task.isBug) {
        weeklyStats[week].bugCount++;
      }
    });

    return weeklyStats;
  }

  async generateCharts(githubData, asanaData) {
    // Generate PR trend chart
    await this.createLineChart(
      "pr-trend.png",
      "PR Trend by Week",
      this.prepareChartData(githubData.weeklyStats, "prCount")
    );

    // Generate Bug trend chart
    await this.createLineChart(
      "bug-trend.png",
      "Bug Trend by Week",
      this.prepareChartData(asanaData.weeklyStats, "bugCount")
    );

    // Generate PR review time trend
    await this.createLineChart(
      "review-time-trend.png",
      "Average PR Review Time (Hours) by Week",
      this.prepareChartData(githubData.weeklyStats, "reviewTime", true)
    );
  }

  prepareChartData(weeklyStats, metric, isAverage = false) {
    return Object.entries(weeklyStats).map(([date, stats]) => ({
      date,
      value: isAverage
        ? stats[metric] / stats.prCount || 0
        : stats[metric] || 0,
    }));
  }

  async createLineChart(filename, title, data) {
    const spec = {
      $schema: "https://vega.github.io/schema/vega/v5.json",
      width: 800,
      height: 400,
      padding: 5,

      data: [
        {
          name: "table",
          values: data,
        },
      ],

      scales: [
        {
          name: "x",
          type: "time",
          range: "width",
          domain: { data: "table", field: "date" },
        },
        {
          name: "y",
          type: "linear",
          range: "height",
          nice: true,
          zero: true,
          domain: { data: "table", field: "value" },
        },
      ],

      axes: [
        { orient: "bottom", scale: "x" },
        { orient: "left", scale: "y" },
      ],

      marks: [
        {
          type: "line",
          from: { data: "table" },
          encode: {
            enter: {
              x: { scale: "x", field: "date" },
              y: { scale: "y", field: "value" },
              strokeWidth: { value: 2 },
              stroke: { value: "#4C78A8" },
            },
          },
        },
        {
          type: "symbol",
          from: { data: "table" },
          encode: {
            enter: {
              x: { scale: "x", field: "date" },
              y: { scale: "y", field: "value" },
              size: { value: 50 },
              fill: { value: "#4C78A8" },
            },
          },
        },
      ],

      title: {
        text: title,
        anchor: "start",
        fontSize: 16,
      },
    };

    const view = new vega.View(vega.parse(spec), { renderer: "none" });
    const svg = await view.toSVG();
    await fs.writeFile(
      path.join("output", filename.replace(".png", ".svg")),
      svg
    );
  }

  async generateReport(githubData, asanaData) {
    const report = {
      github: {
        totalPRs: githubData.prs.length,
        averageReviewTime: this.calculateAverageReviewTime(githubData.prs),
        prTrendByWeek: githubData.weeklyStats,
      },
      asana: {
        totalTasks: asanaData.tasks.length,
        totalBugs: asanaData.bugs.length,
        bugRate: (
          (asanaData.bugs.length / asanaData.tasks.length) *
          100
        ).toFixed(2),
        taskTrendByWeek: asanaData.weeklyStats,
      },
    };

    await fs.writeFile(
      path.join("output", "metrics-report.json"),
      JSON.stringify(report, null, 2)
    );

    return report;
  }

  calculateAverageReviewTime(prs) {
    const mergedPRs = prs.filter((pr) => pr.mergedAt);
    if (mergedPRs.length === 0) return 0;

    const totalReviewTime = mergedPRs.reduce((sum, pr) => {
      return sum + dayjs(pr.mergedAt).diff(dayjs(pr.createdAt), "hour");
    }, 0);

    return (totalReviewTime / mergedPRs.length).toFixed(2);
  }
}

// Usage example
async function main() {
  const analyzer = new DevMetricsAnalyzer(
    "your-github-token",
    "your-asana-token"
  );

  const startDate = dayjs().subtract(1, "year").format("YYYY-MM-DD");
  const endDate = dayjs().format("YYYY-MM-DD");

  await analyzer.collectData(
    "owner", // GitHub repository owner
    "repo-name", // GitHub repository name
    "asana-project-id", // Asana project ID
    startDate,
    endDate
  );
}

main().catch(console.error);
