import type { Env } from '../types/env.js';
import type { GitHubIssue } from '../types/github.js';
import { CONSTANTS } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';
import { getGitHubHeaders } from './client.js';

/**
 * Fetch GitHub issues updated since a specific timestamp
 * Used for polling-based sync
 */
export async function fetchGitHubIssuesSince(
  env: Env,
  owner: string,
  repo: string,
  since: string | null
): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      state: 'all',
      per_page: String(CONSTANTS.PER_PAGE),
      page: String(page),
      sort: 'updated',
      direction: 'desc',
    });

    if (since) {
      params.set('since', since);
    }

    const response = await withRetry(async () => {
      const res = await fetch(
        `${CONSTANTS.GITHUB_API_BASE}/repos/${owner}/${repo}/issues?${params}`,
        {
          headers: getGitHubHeaders(env),
        }
      );

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`GitHub API error: ${res.status} - ${errorText}`);
      }

      return res.json() as Promise<GitHubIssue[]>;
    });

    // Filter out pull requests (they appear in issues API)
    const issuesOnly = response.filter((item) => !item.pull_request);
    issues.push(...issuesOnly);

    // No more pages if we got fewer items than requested
    if (response.length < CONSTANTS.PER_PAGE) break;

    page++;
  }

  return issues;
}

/**
 * Fetch GitHub issues with pagination (async generator)
 * Yields issues one at a time for streaming processing
 */
export async function* fetchGitHubIssues(
  env: Env,
  owner: string,
  repo: string,
  options: { state?: 'open' | 'closed' | 'all'; limit?: number } = {}
): AsyncGenerator<GitHubIssue, void, unknown> {
  const { state = 'open', limit = Infinity } = options;
  let page = 1;
  let fetched = 0;
  const maxPages = 100;

  while (fetched < limit && page <= maxPages) {
    const params = new URLSearchParams({
      state,
      per_page: String(Math.min(CONSTANTS.PER_PAGE, limit - fetched)),
      page: String(page),
      sort: 'created',
      direction: 'asc',
    });

    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/repos/${owner}/${repo}/issues?${params}`,
      {
        headers: getGitHubHeaders(env),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    const items = (await response.json()) as GitHubIssue[];

    for (const item of items) {
      // Skip pull requests
      if (item.pull_request) continue;

      yield item;
      fetched++;
      if (fetched >= limit) break;
    }

    if (items.length < CONSTANTS.PER_PAGE) break;
    if (page >= maxPages) {
      console.warn(`fetchGitHubIssues: Hit max pages (${maxPages}) for ${owner}/${repo}`);
      break;
    }

    page++;
  }
}

/**
 * Get a single GitHub issue by number
 * Returns null if issue doesn't exist (404)
 */
export async function getGitHubIssue(
  env: Env,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GitHubIssue | null> {
  return withRetry(async () => {
    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        headers: getGitHubHeaders(env),
      }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<GitHubIssue>;
  });
}

/**
 * Close a GitHub issue
 */
export async function closeGitHubIssue(
  env: Env,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GitHubIssue> {
  return withRetry(async () => {
    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          ...getGitHubHeaders(env),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: 'closed',
          state_reason: 'completed',
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<GitHubIssue>;
  });
}

/**
 * Reopen a closed GitHub issue
 */
export async function reopenGitHubIssue(
  env: Env,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GitHubIssue> {
  return withRetry(async () => {
    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          ...getGitHubHeaders(env),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: 'open',
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<GitHubIssue>;
  });
}

/**
 * Create a new GitHub issue
 */
export async function createGitHubIssue(
  env: Env,
  owner: string,
  repo: string,
  title: string,
  body?: string,
  milestoneNumber?: number | null
): Promise<GitHubIssue> {
  return withRetry(async () => {
    const issueData: { title: string; body?: string; milestone?: number } = { title };

    if (body) {
      issueData.body = body;
    }

    if (milestoneNumber !== null && milestoneNumber !== undefined) {
      issueData.milestone = milestoneNumber;
    }

    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/repos/${owner}/${repo}/issues`,
      {
        method: 'POST',
        headers: {
          ...getGitHubHeaders(env),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(issueData),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<GitHubIssue>;
  });
}
