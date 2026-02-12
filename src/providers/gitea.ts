import type { GitHubIssue, GitHubMilestone, GitHubRepo } from '../types/github.js';
import type { IssueProvider, ParsedIssueUrl } from './types.js';
import { withRetry } from '../utils/retry.js';

/**
 * Default page size for Gitea API requests
 */
const GITEA_PAGE_LIMIT = 50;

/**
 * Gitea issue provider implementation
 *
 * Gitea's API is intentionally GitHub-compatible but differs in:
 * - Auth header: `token {key}` instead of `Bearer {key}`
 * - API base: `{instanceUrl}/api/v1` instead of `api.github.com`
 * - Issue close: no `state_reason` field
 * - PR filtering: `type=issues` query param instead of filtering `pull_request` field
 * - Pagination: `limit` param instead of `per_page`
 */
export class GiteaProvider implements IssueProvider {
  readonly platform = 'gitea' as const;
  readonly webBaseUrl: string;
  readonly apiBaseUrl: string;
  private token: string;
  private hostPattern: RegExp;

  constructor(instanceUrl: string, token: string) {
    // Normalize: strip trailing slash
    this.webBaseUrl = instanceUrl.replace(/\/+$/, '');
    this.apiBaseUrl = `${this.webBaseUrl}/api/v1`;
    this.token = token;

    // Build regex to match issue URLs from this instance
    // Escape special regex chars in the host portion
    const escaped = this.webBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.hostPattern = new RegExp(`${escaped}\\/([^/]+)\\/([^/]+)\\/issues\\/(\\d+)`);
  }

  private getHeaders(): HeadersInit {
    return {
      Authorization: `token ${this.token}`,
      Accept: 'application/json',
      'User-Agent': 'Todoist-Sync-Worker',
    };
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
        type: 'issues', // Gitea: exclude PRs at the API level
        limit: String(GITEA_PAGE_LIMIT),
        page: String(page),
        sort: 'updated',
      });

      if (since) {
        params.set('since', since);
      }

      const response = await withRetry(async () => {
        const res = await fetch(
          `${this.apiBaseUrl}/repos/${owner}/${repo}/issues?${params}`,
          { headers: this.getHeaders() }
        );

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Gitea API error: ${res.status} - ${errorText}`);
        }

        return res.json() as Promise<GitHubIssue[]>;
      });

      issues.push(...response);

      if (response.length < GITEA_PAGE_LIMIT) break;
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
        type: 'issues',
        limit: String(Math.min(GITEA_PAGE_LIMIT, limit - fetched)),
        page: String(page),
        sort: 'created',
      });

      const response = await fetch(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues?${params}`,
        { headers: this.getHeaders() }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gitea API error: ${response.status} - ${errorText}`);
      }

      const items = (await response.json()) as GitHubIssue[];

      for (const item of items) {
        yield item;
        fetched++;
        if (fetched >= limit) break;
      }

      if (items.length < GITEA_PAGE_LIMIT) break;
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

      if (response.status === 404) return null;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gitea API error: ${response.status} - ${errorText}`);
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
          body: JSON.stringify({ state: 'closed' }), // No state_reason for Gitea
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gitea API error: ${response.status} - ${errorText}`);
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

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gitea API error: ${response.status} - ${errorText}`);
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

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gitea API error: ${response.status} - ${errorText}`);
      }

      return response.json() as Promise<GitHubIssue>;
    });
  }

  async fetchMilestones(owner: string, repo: string): Promise<GitHubMilestone[]> {
    return withRetry(async () => {
      const response = await fetch(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/milestones?state=all&limit=50`,
        { headers: this.getHeaders() }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gitea API error: ${response.status} - ${errorText}`);
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
          body: JSON.stringify({ milestone: milestoneNumber ?? 0 }), // Gitea uses 0 to clear
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gitea API error: ${response.status} - ${errorText}`);
      }
    });
  }

  async *fetchOrgRepos(org: string): AsyncGenerator<GitHubRepo, void, unknown> {
    let page = 1;

    while (true) {
      const params = new URLSearchParams({
        limit: String(GITEA_PAGE_LIMIT),
        page: String(page),
        sort: 'name',
      });

      const response = await fetch(
        `${this.apiBaseUrl}/orgs/${org}/repos?${params}`,
        { headers: this.getHeaders() }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gitea API error: ${response.status} - ${errorText}`);
      }

      const repos = (await response.json()) as GitHubRepo[];

      for (const repo of repos) {
        if (repo.archived || repo.disabled) continue;
        yield repo;
      }

      if (repos.length < GITEA_PAGE_LIMIT) break;
      page++;
    }
  }

  parseIssueUrl(description: string | null | undefined): ParsedIssueUrl | null {
    if (!description) return null;

    const match = description.match(this.hostPattern);
    if (!match) return null;

    const owner = match[1]!;
    const repo = match[2]!;
    const issueNumber = parseInt(match[3]!, 10);

    return {
      owner,
      repo,
      issueNumber,
      url: `${this.webBaseUrl}/${owner}/${repo}/issues/${issueNumber}`,
    };
  }

  buildIssueUrl(owner: string, repo: string, issueNumber: number): string {
    return `${this.webBaseUrl}/${owner}/${repo}/issues/${issueNumber}`;
  }
}
