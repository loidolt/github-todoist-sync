import { describe, it, expect } from 'vitest';

/**
 * Parse GitHub URL from task description
 * Duplicated from worker.js for testing - in production these would be exported
 */
function parseGitHubUrl(description) {
  if (!description) return null;

  // Match: https://github.com/{owner}/{repo}/issues/{number}
  const match = description.match(
    /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/
  );

  if (!match) return null;

  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10),
  };
}

/**
 * Extract owner/repo from task labels
 * Duplicated from worker.js for testing
 */
function getRepoFromLabels(labels) {
  if (!labels || labels.length === 0) return null;

  // Skip common non-repo labels
  const skipLabels = ['github', 'sync', 'todo', 'task', 'urgent', 'high', 'medium', 'low'];

  // First pass: look for explicit owner/repo labels
  // Supports dashes, underscores, and dots in names (e.g., my_org/repo.js)
  for (const label of labels) {
    const match = label.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }

  // Second pass: look for simple repo names
  for (const label of labels) {
    const labelLower = label.toLowerCase();
    if (!skipLabels.includes(labelLower) && /^[\w.-]+$/.test(label)) {
      return { owner: null, repo: label };
    }
  }

  return null;
}

/**
 * Strip the [#issue] prefix from Todoist task content
 * Duplicated from worker.js for testing
 * Also handles legacy [repo-name#123] or [owner/repo#123] format for backwards compatibility
 */
function stripTodoistPrefix(content) {
  if (!content) return content;
  // Match: [#123] at the start (new format)
  // Also matches legacy [repo-name#123] or [owner/repo#123] for backwards compatibility
  return content.replace(/^\[[\w./-]*#\d+\]\s*/, '');
}

describe('parseGitHubUrl', () => {
  it('parses standard GitHub issue URL', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo/issues/123');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', issueNumber: 123 });
  });

  it('parses URL embedded in description text', () => {
    const result = parseGitHubUrl('Check out https://github.com/my-org/my-repo/issues/42 for details');
    expect(result).toEqual({ owner: 'my-org', repo: 'my-repo', issueNumber: 42 });
  });

  it('parses URL with dashes in owner and repo names', () => {
    const result = parseGitHubUrl('https://github.com/my-org-name/my-repo-name/issues/1');
    expect(result).toEqual({ owner: 'my-org-name', repo: 'my-repo-name', issueNumber: 1 });
  });

  it('parses URL with underscores in names', () => {
    const result = parseGitHubUrl('https://github.com/my_org/my_repo/issues/99');
    expect(result).toEqual({ owner: 'my_org', repo: 'my_repo', issueNumber: 99 });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubUrl('https://gitlab.com/owner/repo/issues/1')).toBeNull();
  });

  it('returns null for GitHub URLs without issue path', () => {
    expect(parseGitHubUrl('https://github.com/owner/repo')).toBeNull();
  });

  it('returns null for GitHub pull request URLs', () => {
    expect(parseGitHubUrl('https://github.com/owner/repo/pull/123')).toBeNull();
  });

  it('returns null for null description', () => {
    expect(parseGitHubUrl(null)).toBeNull();
  });

  it('returns null for undefined description', () => {
    expect(parseGitHubUrl(undefined)).toBeNull();
  });

  it('returns null for empty description', () => {
    expect(parseGitHubUrl('')).toBeNull();
  });

  it('handles multi-digit issue numbers', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo/issues/12345');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', issueNumber: 12345 });
  });
});

describe('getRepoFromLabels', () => {
  it('parses owner/repo format label', () => {
    const result = getRepoFromLabels(['my-org/my-repo']);
    expect(result).toEqual({ owner: 'my-org', repo: 'my-repo' });
  });

  it('parses simple repo name label', () => {
    const result = getRepoFromLabels(['my-repo']);
    expect(result).toEqual({ owner: null, repo: 'my-repo' });
  });

  it('prefers owner/repo format over simple repo name', () => {
    const result = getRepoFromLabels(['simple-repo', 'my-org/specific-repo']);
    expect(result).toEqual({ owner: 'my-org', repo: 'specific-repo' });
  });

  it('skips common non-repo labels (github)', () => {
    const result = getRepoFromLabels(['github', 'my-repo']);
    expect(result).toEqual({ owner: null, repo: 'my-repo' });
  });

  it('skips common non-repo labels (sync)', () => {
    const result = getRepoFromLabels(['sync', 'my-repo']);
    expect(result).toEqual({ owner: null, repo: 'my-repo' });
  });

  it('skips common non-repo labels (todo)', () => {
    const result = getRepoFromLabels(['todo', 'my-repo']);
    expect(result).toEqual({ owner: null, repo: 'my-repo' });
  });

  it('skips common non-repo labels (urgent)', () => {
    const result = getRepoFromLabels(['urgent', 'my-repo']);
    expect(result).toEqual({ owner: null, repo: 'my-repo' });
  });

  it('skips priority labels', () => {
    const result = getRepoFromLabels(['high', 'medium', 'low', 'my-repo']);
    expect(result).toEqual({ owner: null, repo: 'my-repo' });
  });

  it('is case-insensitive for skip labels', () => {
    const result = getRepoFromLabels(['GITHUB', 'URGENT', 'my-repo']);
    expect(result).toEqual({ owner: null, repo: 'my-repo' });
  });

  it('returns null for empty labels array', () => {
    expect(getRepoFromLabels([])).toBeNull();
  });

  it('returns null for null labels', () => {
    expect(getRepoFromLabels(null)).toBeNull();
  });

  it('returns null for undefined labels', () => {
    expect(getRepoFromLabels(undefined)).toBeNull();
  });

  it('returns null when only skip labels are present', () => {
    expect(getRepoFromLabels(['github', 'sync', 'urgent'])).toBeNull();
  });

  it('handles labels with underscores', () => {
    const result = getRepoFromLabels(['my_repo']);
    expect(result).toEqual({ owner: null, repo: 'my_repo' });
  });

  it('handles owner/repo with underscores', () => {
    const result = getRepoFromLabels(['my_org/my_repo']);
    expect(result).toEqual({ owner: 'my_org', repo: 'my_repo' });
  });

  it('returns first valid owner/repo when multiple present', () => {
    const result = getRepoFromLabels(['org1/repo1', 'org2/repo2']);
    expect(result).toEqual({ owner: 'org1', repo: 'repo1' });
  });

  it('handles owner/repo with dots', () => {
    const result = getRepoFromLabels(['my-org/repo.js']);
    expect(result).toEqual({ owner: 'my-org', repo: 'repo.js' });
  });

  it('handles simple repo name with dots', () => {
    const result = getRepoFromLabels(['my-app.io']);
    expect(result).toEqual({ owner: null, repo: 'my-app.io' });
  });

  it('handles complex names with dots, dashes, and underscores', () => {
    const result = getRepoFromLabels(['my_org.io/my-repo_v2.js']);
    expect(result).toEqual({ owner: 'my_org.io', repo: 'my-repo_v2.js' });
  });
});

describe('stripTodoistPrefix', () => {
  // New format tests [#N]
  it('strips new [#N] prefix format', () => {
    const result = stripTodoistPrefix('[#123] Fix the bug');
    expect(result).toBe('Fix the bug');
  });

  it('strips new format with multi-digit issue numbers', () => {
    const result = stripTodoistPrefix('[#12345] Large issue number');
    expect(result).toBe('Large issue number');
  });

  it('strips new format without trailing space', () => {
    const result = stripTodoistPrefix('[#1]No space after');
    expect(result).toBe('No space after');
  });

  it('strips new format with multiple spaces', () => {
    const result = stripTodoistPrefix('[#1]   Multiple spaces');
    expect(result).toBe('Multiple spaces');
  });

  // Legacy format tests (backwards compatibility)
  it('strips legacy repo#issue prefix', () => {
    const result = stripTodoistPrefix('[my-repo#123] Fix the bug');
    expect(result).toBe('Fix the bug');
  });

  it('strips legacy owner/repo#issue prefix', () => {
    const result = stripTodoistPrefix('[my-org/my-repo#456] Add feature');
    expect(result).toBe('Add feature');
  });

  it('strips legacy prefix with underscores and dots', () => {
    const result = stripTodoistPrefix('[my_org.io/repo.js#789] Update docs');
    expect(result).toBe('Update docs');
  });

  it('strips legacy format without trailing space', () => {
    const result = stripTodoistPrefix('[repo#1]No space after');
    expect(result).toBe('No space after');
  });

  // Edge cases
  it('returns original content if no prefix', () => {
    const result = stripTodoistPrefix('Just a regular task');
    expect(result).toBe('Just a regular task');
  });

  it('returns null for null input', () => {
    expect(stripTodoistPrefix(null)).toBeNull();
  });

  it('returns undefined for undefined input', () => {
    expect(stripTodoistPrefix(undefined)).toBeUndefined();
  });

  it('returns empty string for empty input', () => {
    expect(stripTodoistPrefix('')).toBe('');
  });

  it('does not strip prefix in middle of string', () => {
    const result = stripTodoistPrefix('See [#123] for details');
    expect(result).toBe('See [#123] for details');
  });

  it('does not strip legacy prefix in middle of string', () => {
    const result = stripTodoistPrefix('See [repo#123] for details');
    expect(result).toBe('See [repo#123] for details');
  });
});
