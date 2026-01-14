/**
 * GitHub milestone
 */
export interface GitHubMilestone {
  number: number;
  title: string;
  state: 'open' | 'closed';
  description?: string | null;
}

/**
 * GitHub label
 */
export interface GitHubLabel {
  name: string;
  color?: string;
  description?: string | null;
}

/**
 * GitHub issue from the API
 */
export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  body?: string | null;
  milestone?: GitHubMilestone | null;
  labels: GitHubLabel[];

  /** Present if this is a pull request */
  pull_request?: unknown;

  /** Enriched during polling - repo owner */
  _repoOwner?: string;

  /** Enriched during polling - repo name */
  _repoName?: string;

  /** Enriched during polling - full repo name (owner/repo) */
  _repoFullName?: string;

  /** Enriched during polling - corresponding Todoist project ID */
  _todoistProjectId?: string;
}

/**
 * GitHub repository
 */
export interface GitHubRepo {
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
  private: boolean;
  archived: boolean;
  disabled: boolean;
}

/**
 * Parsed GitHub URL information
 */
export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  issueNumber: number;
  url: string;
}
