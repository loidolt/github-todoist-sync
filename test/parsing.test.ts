import { describe, it, expect } from 'vitest';
import { parseGitHubUrl, stripTodoistPrefix } from '../src/utils/helpers.js';

describe('parseGitHubUrl', () => {
  it('parses standard GitHub issue URL', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo/issues/123');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', issueNumber: 123, url: 'https://github.com/owner/repo/issues/123' });
  });

  it('parses URL embedded in description text', () => {
    const result = parseGitHubUrl('Check out https://github.com/my-org/my-repo/issues/42 for details');
    expect(result).toEqual({ owner: 'my-org', repo: 'my-repo', issueNumber: 42, url: 'https://github.com/my-org/my-repo/issues/42' });
  });

  it('parses URL with dashes in owner and repo names', () => {
    const result = parseGitHubUrl('https://github.com/my-org-name/my-repo-name/issues/1');
    expect(result).toEqual({ owner: 'my-org-name', repo: 'my-repo-name', issueNumber: 1, url: 'https://github.com/my-org-name/my-repo-name/issues/1' });
  });

  it('parses URL with underscores in names', () => {
    const result = parseGitHubUrl('https://github.com/my_org/my_repo/issues/99');
    expect(result).toEqual({ owner: 'my_org', repo: 'my_repo', issueNumber: 99, url: 'https://github.com/my_org/my_repo/issues/99' });
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
    expect(parseGitHubUrl(null as unknown as string)).toBeNull();
  });

  it('returns null for undefined description', () => {
    expect(parseGitHubUrl(undefined as unknown as string)).toBeNull();
  });

  it('returns null for empty description', () => {
    expect(parseGitHubUrl('')).toBeNull();
  });

  it('handles multi-digit issue numbers', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo/issues/12345');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', issueNumber: 12345, url: 'https://github.com/owner/repo/issues/12345' });
  });
});

describe('stripTodoistPrefix', () => {
  it('strips [#N] prefix format', () => {
    const result = stripTodoistPrefix('[#123] Fix the bug');
    expect(result).toBe('Fix the bug');
  });

  it('strips prefix with multi-digit issue numbers', () => {
    const result = stripTodoistPrefix('[#12345] Large issue number');
    expect(result).toBe('Large issue number');
  });

  it('strips prefix without trailing space', () => {
    const result = stripTodoistPrefix('[#1]No space after');
    expect(result).toBe('No space after');
  });

  it('strips prefix with multiple spaces', () => {
    const result = stripTodoistPrefix('[#1]   Multiple spaces');
    expect(result).toBe('Multiple spaces');
  });

  // Edge cases
  it('returns original content if no prefix', () => {
    const result = stripTodoistPrefix('Just a regular task');
    expect(result).toBe('Just a regular task');
  });

  it('returns empty string for empty input', () => {
    expect(stripTodoistPrefix('')).toBe('');
  });

  it('does not strip prefix in middle of string', () => {
    const result = stripTodoistPrefix('See [#123] for details');
    expect(result).toBe('See [#123] for details');
  });

  it('does not strip other bracket patterns', () => {
    const result = stripTodoistPrefix('See [repo#123] for details');
    expect(result).toBe('See [repo#123] for details');
  });
});
