import type { GitHubIssue, GitHubMilestone, GitHubRepo } from '../types/github.js';
import type { IssueProvider, ParsedIssueUrl } from './types.js';
import { CONSTANTS } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';

/**
 * GitHub rate limit information extracted from response headers
 */
export interface GitHubRateLimit {
  limit: number;
  remaining: number;
  reset: number;
  resource: string;
  resetAt: string;
  isLow: boolean;
}

/**
 * GitHub issue provider implementation
 */
export class GitHubProvider implements IssueProvider {
  readonly platform = 'github' as const;
  readonly webBaseUrl = 'https://github.com';
  readonly apiBaseUrl: string;
  private token: string;
  private lastRateLimit: GitHubRateLimit | null = null;

  constructor(token: string, apiBaseUrl = 'https://api.github.com') {
    this.token = token;
    this.apiBaseUrl = apiBaseUrl;
  }

  getLastRateLimit(): GitHubRateLimit | null {
    return this.lastRateLimit;
  }

  private getHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'GitHub-Todoist-Sync-Worker',
    };
  }

  private extractRateLimit(response: Response): GitHubRateLimit | null {
    const limit = response.headers.get('x-ratelimit-limit');
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const resource = response.headers.get('x-ratelimit-resource');

    if (!limit || !remaining || !reset) return null;

    const limitNum = parseInt(limit, 10);
    const remainingNum = parseInt(remaining, 10);
    const resetNum = parseInt(reset, 10);
    const resetDate = new Date(resetNum * 1000);

    return {
      limit: limitNum,
      remaining: remainingNum,
      reset: resetNum,
      resource: resource ?? 'core',
      resetAt: resetDate.toISOString(),
      isLow: remainingNum < limitNum * 0.1,
    };
  }

  private trackRateLimit(response: Response): void {
    const rateLimit = this.extractRateLimit(response);
    if (rateLimit) {
      this.lastRateLimit = rateLimit;
      if (rateLimit.isLow) {
        console.warn(
          `GitHub rate limit low: ${rateLimit.remaining}/${rateLimit.limit} remaining, resets at ${rateLimit.resetAt}`
        );
      }
    }
  }

  async fetchIssuesSince(
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
          `${this.apiBaseUrl}/repos/${owner}/${repo}/issues?${params}`,
          { headers: this.getHeaders() }
        );

        this.trackRateLimit(res);

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`GitHub API error: ${res.status} - ${errorText}`);
        }

        return res.json() as Promise<GitHubIssue[]>;
      });

      // Filter out pull requests (they appear in GitHub issues API)
      const issuesOnly = response.filter((item) => !item.pull_request);
      issues.push(...issuesOnly);

      if (response.length < CONSTANTS.PER_PAGE) break;
      page++;
    }

    return issues;
  }

  async *fetchIssues(
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
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues?${params}`,
        { headers: this.getHeaders() }
      );

      this.trackRateLimit(response);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
      }

      const items = (await response.json()) as GitHubIssue[];

      for (const item of items) {
        if (item.pull_request) continue;
        yield item;
        fetched++;
        if (fetched >= limit) break;
      }

      if (items.length < CONSTANTS.PER_PAGE) break;
      if (page >= maxPages) {
        console.warn(`fetchIssues: Hit max pages (${maxPages}) for ${owner}/${repo}`);
        break;
      }

      page++;
    }
  }

  async getIssue(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<GitHubIssue | null> {
    return withRetry(async () => {
      const response = await fetch(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${issueNumber}`,
        { headers: this.getHeaders() }
      );

      this.trackRateLimit(response);

      if (response.status === 404) return null;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
      }

      return response.json() as Promise<GitHubIssue>;
    });
  }

  async closeIssue(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<GitHubIssue> {
    return withRetry(async () => {
      const response = await fetch(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          method: 'PATCH',
          headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
        }
      );

      this.trackRateLimit(response);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
      }

      return response.json() as Promise<GitHubIssue>;
    });
  }

  async reopenIssue(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<GitHubIssue> {
    return withRetry(async () => {
      const response = await fetch(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          method: 'PATCH',
          headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'open' }),
        }
      );

      this.trackRateLimit(response);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
      }

      return response.json() as Promise<GitHubIssue>;
    });
  }

  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body?: string,
    milestoneNumber?: number | null
  ): Promise<GitHubIssue> {
    return withRetry(async () => {
      const issueData: { title: string; body?: string; milestone?: number } = { title };

      if (body) issueData.body = body;
      if (milestoneNumber !== null && milestoneNumber !== undefined) {
        issueData.milestone = milestoneNumber;
      }

      const response = await fetch(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues`,
        {
          method: 'POST',
          headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(issueData),
        }
      );

      this.trackRateLimit(response);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
      }

      return response.json() as Promise<GitHubIssue>;
    });
  }

  async fetchMilestones(owner: string, repo: string): Promise<GitHubMilestone[]> {
    return withRetry(async () => {
      const response = await fetch(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/milestones?state=all&per_page=100`,
        { headers: this.getHeaders() }
      );

      this.trackRateLimit(response);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
      }

      return response.json() as Promise<GitHubMilestone[]>;
    });
  }

  async updateIssueMilestone(
    owner: string,
    repo: string,
    issueNumber: number,
    milestoneNumber: number | null
  ): Promise<void> {
    return withRetry(async () => {
      const response = await fetch(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          method: 'PATCH',
          headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ milestone: milestoneNumber }),
        }
      );

      this.trackRateLimit(response);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
      }
    });
  }

  async *fetchOrgRepos(org: string): AsyncGenerator<GitHubRepo, void, unknown> {
    let page = 1;

    while (true) {
      const params = new URLSearchParams({
        per_page: String(CONSTANTS.PER_PAGE),
        page: String(page),
        sort: 'name',
      });

      const response = await fetch(
        `${this.apiBaseUrl}/orgs/${org}/repos?${params}`,
        { headers: this.getHeaders() }
      );

      this.trackRateLimit(response);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
      }

      const repos = (await response.json()) as GitHubRepo[];

      for (const repo of repos) {
        if (repo.archived || repo.disabled) continue;
        yield repo;
      }

      if (repos.length < CONSTANTS.PER_PAGE) break;
      page++;
    }
  }

  parseIssueUrl(description: string | null | undefined): ParsedIssueUrl | null {
    if (!description) return null;

    const match = description.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!match) return null;

    const owner = match[1]!;
    const repo = match[2]!;
    const issueNumber = parseInt(match[3]!, 10);

    return {
      owner,
      repo,
      issueNumber,
      url: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
    };
  }

  buildIssueUrl(owner: string, repo: string, issueNumber: number): string {
    return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
  }
}
