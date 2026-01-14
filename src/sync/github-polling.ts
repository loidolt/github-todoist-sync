import type { Env } from '../types/env.js';
import type { GitHubIssue } from '../types/github.js';
import type { ProjectHierarchy } from '../types/todoist.js';
import type { Logger } from '../logging/logger.js';
import { fetchGitHubIssuesSince } from '../github/issues.js';

/**
 * Error information for a repo that failed during polling
 */
export interface RepoPollingError {
  repo: string;
  error: string;
}

/**
 * Result of polling GitHub for changes
 */
export interface GitHubPollResult {
  issues: GitHubIssue[];
  repoErrors: RepoPollingError[];
  successfulRepos: number;
  failedRepos: number;
}

/**
 * Poll GitHub for issues updated since last sync
 * Uses project hierarchy to determine which repos to sync
 *
 * @param env - Environment with API tokens
 * @param since - ISO timestamp to fetch issues updated since (null for all)
 * @param projectHierarchy - Todoist project hierarchy with org/repo mappings
 * @param logger - Logger instance for structured logging
 * @returns Poll result with issues and per-repo error tracking
 */
export async function pollGitHubChanges(
  env: Env,
  since: string | null,
  projectHierarchy: ProjectHierarchy,
  logger: Logger
): Promise<GitHubPollResult> {
  const pollLogger = logger.child({ operation: 'github-polling' });
  const issues: GitHubIssue[] = [];
  const repoErrors: RepoPollingError[] = [];
  const { subProjects } = projectHierarchy;

  // Get unique repos from sub-projects
  const repos = Array.from(subProjects.values()).map((p) => ({
    owner: p.githubOrg,
    name: p.repoName,
    projectId: p.id,
  }));

  pollLogger.info(`Polling ${repos.length} repo(s) from Todoist project hierarchy`, {
    repoCount: repos.length,
  });

  let successfulRepos = 0;
  let failedRepos = 0;

  for (const repo of repos) {
    const repoFullName = `${repo.owner}/${repo.name}`;
    const repoLogger = pollLogger.child({ repo: repoFullName });

    try {
      repoLogger.debug(`Fetching issues since ${since ?? 'beginning'}`);
      const repoIssues = await fetchGitHubIssuesSince(env, repo.owner, repo.name, since);

      // Add project info to each issue
      for (const issue of repoIssues) {
        issue._todoistProjectId = repo.projectId;
        issue._repoOwner = repo.owner;
        issue._repoName = repo.name;
        issue._repoFullName = repoFullName;
      }
      issues.push(...repoIssues);
      successfulRepos++;

      if (repoIssues.length > 0) {
        repoLogger.debug(`Found ${repoIssues.length} issue(s)`, { issueCount: repoIssues.length });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      repoLogger.error(`Failed to fetch issues`, error, { repo: repoFullName });
      repoErrors.push({ repo: repoFullName, error: errorMessage });
      failedRepos++;
      // Continue with other repos
    }
  }

  if (repoErrors.length > 0) {
    pollLogger.warn(`Completed with ${failedRepos} repo error(s)`, {
      failedRepos,
      successfulRepos,
      errors: repoErrors,
    });
  }

  return { issues, repoErrors, successfulRepos, failedRepos };
}
