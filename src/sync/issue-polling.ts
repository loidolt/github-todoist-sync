import type { GitHubIssue } from '../types/github.js';
import type { ProjectHierarchy } from '../types/todoist.js';
import type { ProviderRegistry } from '../providers/types.js';
import type { Logger } from '../logging/logger.js';

/**
 * Error information for a repo that failed during polling
 */
export interface RepoPollingError {
  repo: string;
  error: string;
}

/**
 * Result of polling issue providers for changes
 */
export interface IssuePollResult {
  issues: GitHubIssue[];
  repoErrors: RepoPollingError[];
  successfulRepos: number;
  failedRepos: number;
}

/**
 * Poll issue providers for issues updated since last sync
 * Uses project hierarchy to determine which repos to sync and
 * the provider registry to select the correct platform for each repo.
 */
export async function pollIssueChanges(
  since: string | null,
  projectHierarchy: ProjectHierarchy,
  providerRegistry: ProviderRegistry,
  logger: Logger
): Promise<IssuePollResult> {
  const pollLogger = logger.child({ operation: 'issue-polling' });
  const issues: GitHubIssue[] = [];
  const repoErrors: RepoPollingError[] = [];
  const { subProjects } = projectHierarchy;

  // Get unique repos from sub-projects
  const repos = Array.from(subProjects.values()).map((p) => ({
    owner: p.org,
    name: p.repoName,
    projectId: p.id,
    parentId: p.parentId,
  }));

  pollLogger.info(`Polling ${repos.length} repo(s) from Todoist project hierarchy`, {
    repoCount: repos.length,
  });

  let successfulRepos = 0;
  let failedRepos = 0;

  for (const repo of repos) {
    const repoFullName = `${repo.owner}/${repo.name}`;
    const repoLogger = pollLogger.child({ repo: repoFullName });

    const provider = providerRegistry.get(repo.parentId);
    if (!provider) {
      repoLogger.warn('No provider found for parent project', { parentId: repo.parentId });
      repoErrors.push({ repo: repoFullName, error: 'No provider configured for parent project' });
      failedRepos++;
      continue;
    }

    try {
      repoLogger.debug(`Fetching issues since ${since ?? 'beginning'}`);
      const repoIssues = await provider.fetchIssuesSince(repo.owner, repo.name, since);

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
