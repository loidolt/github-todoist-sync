import type { GitHubIssue, GitHubMilestone, GitHubRepo } from '../types/github.js';

/**
 * Supported git hosting platforms
 */
export type Platform = 'github' | 'gitea';

/**
 * Parsed issue URL information (platform-agnostic)
 */
export interface ParsedIssueUrl {
  owner: string;
  repo: string;
  issueNumber: number;
  url: string;
}

/**
 * Configuration for a single org mapping entry
 */
export interface OrgConfig {
  org: string;
  platform: Platform;
  /** Web-facing base URL, e.g. 'https://github.com' or 'https://gitea.example.com' */
  instanceUrl: string;
}

/**
 * Map of Todoist parent project ID -> OrgConfig
 */
export type OrgMappings = Map<string, OrgConfig>;

/**
 * Abstraction over a git hosting platform's issue API.
 * Implemented by GitHubProvider and GiteaProvider.
 */
export interface IssueProvider {
  readonly platform: Platform;
  /** Web-facing base URL, e.g. 'https://github.com' or 'https://gitea.example.com' */
  readonly webBaseUrl: string;
  /** API base URL, e.g. 'https://api.github.com' or 'https://gitea.example.com/api/v1' */
  readonly apiBaseUrl: string;

  // --- Issues ---
  fetchIssuesSince(owner: string, repo: string, since: string | null): Promise<GitHubIssue[]>;
  fetchIssues(
    owner: string,
    repo: string,
    options?: { state?: 'open' | 'closed' | 'all'; limit?: number }
  ): AsyncGenerator<GitHubIssue, void, unknown>;
  getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue | null>;
  closeIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue>;
  reopenIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue>;
  createIssue(
    owner: string,
    repo: string,
    title: string,
    body?: string,
    milestoneNumber?: number | null
  ): Promise<GitHubIssue>;

  // --- Milestones ---
  fetchMilestones(owner: string, repo: string): Promise<GitHubMilestone[]>;
  updateIssueMilestone(
    owner: string,
    repo: string,
    issueNumber: number,
    milestoneNumber: number | null
  ): Promise<void>;

  // --- Repos ---
  fetchOrgRepos(org: string): AsyncGenerator<GitHubRepo, void, unknown>;

  // --- URL utilities ---
  parseIssueUrl(description: string | null | undefined): ParsedIssueUrl | null;
  buildIssueUrl(owner: string, repo: string, issueNumber: number): string;
}

/**
 * Registry mapping parent Todoist project IDs to their issue providers
 */
export type ProviderRegistry = Map<string, IssueProvider>;
