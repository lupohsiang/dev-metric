import { Octokit } from "@octokit/rest";
import { config } from "dotenv";

// Initialize dotenv
config();

class GitHubStatsAnalyzer {
  constructor(token) {
    this.octokit = new Octokit({
      auth: token,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  }

  async getRepositoryStats(owner, repo) {
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

      // Get PR statistics
      const pullRequests = await this.octokit.request(
        "GET /repos/{owner}/{repo}/pulls",
        {
          owner,
          repo,
          state: "all",
          sort: "created",
          direction: "desc",
          per_page: 100,
        }
      );

      // Get deployment statistics
      const deployments = await this.octokit.request(
        "GET /repos/{owner}/{repo}/deployments",
        {
          owner,
          repo,
          per_page: 100,
        }
      );

      // Process and analyze the data
      const stats = this.processStats(
        commitActivity,
        pullRequests.data,
        deployments.data
      );
      return stats;
    } catch (error) {
      console.error("Error fetching repository statistics:", error.message);
      throw error;
    }
  }

  async retryRequest(requestFn, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await requestFn();
        if (response && Array.isArray(response)) return response;
        console.log(`Attempt ${i + 1}: Waiting for GitHub to compute statistics...`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
      } catch (error) {
        if (error.status === 202) {
          console.log(`Attempt ${i + 1}: GitHub is computing statistics (202 status)...`);
          await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
          continue;
        }
        throw error;
      }
    }
    console.log('Maximum retries reached, returning empty array');
    return [];
  }

  processStats(commitActivity, pullRequests, deployments) {
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

    return {
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
        recentPRsPerWeek: (recentPRs.length / 4).toFixed(2), // Last 4 weeks
      },
      deploymentStats: {
        ...deploymentMetrics,
        recentDeploymentCount: recentDeployments.length,
        recentDeploymentsPerWeek: (recentDeployments.length / 4).toFixed(2), // Last 4 weeks
      },
    };
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
   - Recent PR frequency (last month): ${
     stats.prStats.recentPRsPerWeek
   } PRs/week

3. Deployment Metrics
   - Total deployments: ${stats.deploymentStats.totalDeployments}
   - Average deployments per week: ${stats.deploymentStats.averageDeploymentsPerWeek.toFixed(
     2
   )}
   - Recent deployment frequency (last month): ${
     stats.deploymentStats.recentDeploymentsPerWeek
   } deployments/week
`;
  }
}

// Example usage
async function main() {
  const token = process.env.GITHUB_TOKEN;
  const analyzer = new GitHubStatsAnalyzer(token);

  try {
    const stats = await analyzer.getRepositoryStats(
      process.env.GITHUB_OWNER,
      process.env.GITHUB_REPO
    );
    const report = analyzer.generateReport(stats);
    console.log(report);
  } catch (error) {
    console.error("Error generating report:", error);
  }
}

main();
