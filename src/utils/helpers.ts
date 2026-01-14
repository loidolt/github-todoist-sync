import type { TodoistTask, TodoistSyncTask, ParsedGitHubUrl } from '../types/index.js';

/**
 * Create a JSON response with proper headers
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Check if a Todoist task is completed
 * Handles both REST API (is_completed) and Sync API (checked) formats
 */
export function isTaskCompleted(task: TodoistTask | TodoistSyncTask): boolean {
  const restTask = task as TodoistTask;
  const syncTask = task as TodoistSyncTask;
  return restTask.is_completed === true || syncTask.checked === 1;
}

/**
 * Strip the [#issue] prefix from Todoist task content
 * Used when creating GitHub issues from Todoist tasks
 */
export function stripTodoistPrefix(content: string | null | undefined): string {
  if (!content) return '';
  // Match: [#123] at the start (new format)
  // Also matches legacy [repo-name#123] or [owner/repo#123] for backwards compatibility
  return content.replace(/^\[[\w./-]*#\d+\]\s*/, '');
}

/**
 * Parse GitHub issue URL from a string (typically task description)
 * Returns parsed info or null if no valid URL found
 */
export function parseGitHubUrl(description: string | null | undefined): ParsedGitHubUrl | null {
  if (!description) return null;

  // Match: https://github.com/{owner}/{repo}/issues/{number}
  const match = description.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);

  if (!match) return null;

  const owner = match[1];
  const repo = match[2];
  const issueNumber = parseInt(match[3]!, 10);

  return {
    owner: owner!,
    repo: repo!,
    issueNumber,
    url: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
  };
}

/**
 * Extract repo name from Todoist labels
 * Used for legacy repo detection via labels
 */
export function getRepoFromLabels(labels: string[]): string | null {
  // Look for a label that looks like a repo name
  // This is a legacy feature, prefer project hierarchy instead
  for (const label of labels) {
    if (label.includes('/') || /^[\w-]+$/.test(label)) {
      return label;
    }
  }
  return null;
}

/**
 * Format a task content with issue prefix
 */
export function formatTaskContent(issueNumber: number, title: string): string {
  return `[#${issueNumber}] ${title}`;
}

/**
 * Extract issue number from task content prefix
 * Returns the issue number or null if not found
 */
export function extractIssueNumberFromContent(content: string): number | null {
  const match = content.match(/^\[#(\d+)\]/);
  if (!match) return null;
  return parseInt(match[1]!, 10);
}
