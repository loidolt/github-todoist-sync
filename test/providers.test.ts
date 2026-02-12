import { describe, it, expect } from 'vitest';
import { GitHubProvider } from '../src/providers/github.js';
import { GiteaProvider } from '../src/providers/gitea.js';
import { createProvider, createProviderRegistry } from '../src/providers/factory.js';
import { parseIssueUrlFromAnyProvider } from '../src/providers/url-parsing.js';
import type { OrgConfig, OrgMappings } from '../src/providers/types.js';

describe('GitHubProvider', () => {
  const provider = new GitHubProvider('test-token');

  describe('properties', () => {
    it('has correct platform', () => {
      expect(provider.platform).toBe('github');
    });

    it('has correct webBaseUrl', () => {
      expect(provider.webBaseUrl).toBe('https://github.com');
    });

    it('has correct apiBaseUrl', () => {
      expect(provider.apiBaseUrl).toBe('https://api.github.com');
    });
  });

  describe('parseIssueUrl', () => {
    it('parses standard GitHub issue URL', () => {
      const result = provider.parseIssueUrl('https://github.com/owner/repo/issues/123');
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        issueNumber: 123,
        url: 'https://github.com/owner/repo/issues/123',
      });
    });

    it('parses URL embedded in description text', () => {
      const result = provider.parseIssueUrl('See https://github.com/my-org/my-repo/issues/42 for details');
      expect(result).toEqual({
        owner: 'my-org',
        repo: 'my-repo',
        issueNumber: 42,
        url: 'https://github.com/my-org/my-repo/issues/42',
      });
    });

    it('returns null for Gitea URLs', () => {
      expect(provider.parseIssueUrl('https://gitea.example.com/org/repo/issues/1')).toBeNull();
    });

    it('returns null for non-issue URLs', () => {
      expect(provider.parseIssueUrl('https://github.com/owner/repo/pull/123')).toBeNull();
    });

    it('returns null for null/undefined/empty', () => {
      expect(provider.parseIssueUrl(null)).toBeNull();
      expect(provider.parseIssueUrl(undefined)).toBeNull();
      expect(provider.parseIssueUrl('')).toBeNull();
    });
  });

  describe('buildIssueUrl', () => {
    it('builds correct GitHub issue URL', () => {
      expect(provider.buildIssueUrl('owner', 'repo', 42)).toBe(
        'https://github.com/owner/repo/issues/42'
      );
    });
  });
});

describe('GiteaProvider', () => {
  const provider = new GiteaProvider('https://gitea.example.com', 'test-token');

  describe('properties', () => {
    it('has correct platform', () => {
      expect(provider.platform).toBe('gitea');
    });

    it('has correct webBaseUrl', () => {
      expect(provider.webBaseUrl).toBe('https://gitea.example.com');
    });

    it('has correct apiBaseUrl', () => {
      expect(provider.apiBaseUrl).toBe('https://gitea.example.com/api/v1');
    });

    it('strips trailing slash from instanceUrl', () => {
      const p = new GiteaProvider('https://gitea.example.com/', 'token');
      expect(p.webBaseUrl).toBe('https://gitea.example.com');
      expect(p.apiBaseUrl).toBe('https://gitea.example.com/api/v1');
    });
  });

  describe('parseIssueUrl', () => {
    it('parses Gitea issue URL', () => {
      const result = provider.parseIssueUrl('https://gitea.example.com/org/repo/issues/5');
      expect(result).toEqual({
        owner: 'org',
        repo: 'repo',
        issueNumber: 5,
        url: 'https://gitea.example.com/org/repo/issues/5',
      });
    });

    it('parses URL embedded in description text', () => {
      const result = provider.parseIssueUrl('See https://gitea.example.com/my-org/my-repo/issues/10 for details');
      expect(result).toEqual({
        owner: 'my-org',
        repo: 'my-repo',
        issueNumber: 10,
        url: 'https://gitea.example.com/my-org/my-repo/issues/10',
      });
    });

    it('returns null for GitHub URLs', () => {
      expect(provider.parseIssueUrl('https://github.com/owner/repo/issues/1')).toBeNull();
    });

    it('returns null for URLs from a different Gitea instance', () => {
      expect(provider.parseIssueUrl('https://other-gitea.com/owner/repo/issues/1')).toBeNull();
    });

    it('returns null for null/undefined/empty', () => {
      expect(provider.parseIssueUrl(null)).toBeNull();
      expect(provider.parseIssueUrl(undefined)).toBeNull();
      expect(provider.parseIssueUrl('')).toBeNull();
    });
  });

  describe('buildIssueUrl', () => {
    it('builds correct Gitea issue URL', () => {
      expect(provider.buildIssueUrl('org', 'repo', 42)).toBe(
        'https://gitea.example.com/org/repo/issues/42'
      );
    });
  });
});

describe('createProvider', () => {
  it('creates GitHubProvider for github platform', () => {
    const config: OrgConfig = { org: 'my-org', platform: 'github', instanceUrl: 'https://github.com' };
    const env = { GITHUB_TOKEN: 'test-token' } as import('../src/types/env.js').Env;
    const provider = createProvider(config, env);
    expect(provider.platform).toBe('github');
    expect(provider.webBaseUrl).toBe('https://github.com');
  });

  it('creates GiteaProvider for gitea platform', () => {
    const config: OrgConfig = { org: 'my-org', platform: 'gitea', instanceUrl: 'https://gitea.example.com' };
    const env = {
      GITHUB_TOKEN: 'test-token',
      GITEA_TOKENS: JSON.stringify({ 'https://gitea.example.com': 'gitea-token' }),
    } as import('../src/types/env.js').Env;
    const provider = createProvider(config, env);
    expect(provider.platform).toBe('gitea');
    expect(provider.webBaseUrl).toBe('https://gitea.example.com');
  });

  it('throws for missing Gitea token', () => {
    const config: OrgConfig = { org: 'my-org', platform: 'gitea', instanceUrl: 'https://gitea.example.com' };
    const env = { GITHUB_TOKEN: 'test-token' } as import('../src/types/env.js').Env;
    expect(() => createProvider(config, env)).toThrow('No Gitea token found');
  });
});

describe('createProviderRegistry', () => {
  it('creates registry with deduplication', () => {
    const mappings: OrgMappings = new Map([
      ['100', { org: 'org-a', platform: 'github', instanceUrl: 'https://github.com' }],
      ['200', { org: 'org-b', platform: 'github', instanceUrl: 'https://github.com' }],
    ]);
    const env = { GITHUB_TOKEN: 'test-token' } as import('../src/types/env.js').Env;
    const registry = createProviderRegistry(mappings, env);

    expect(registry.size).toBe(2);
    // Both should use the same provider instance (deduplication)
    expect(registry.get('100')).toBe(registry.get('200'));
  });

  it('creates separate providers for different platforms', () => {
    const mappings: OrgMappings = new Map([
      ['100', { org: 'gh-org', platform: 'github', instanceUrl: 'https://github.com' }],
      ['200', { org: 'gt-org', platform: 'gitea', instanceUrl: 'https://gitea.test.com' }],
    ]);
    const env = {
      GITHUB_TOKEN: 'test-token',
      GITEA_TOKENS: JSON.stringify({ 'https://gitea.test.com': 'gitea-token' }),
    } as import('../src/types/env.js').Env;
    const registry = createProviderRegistry(mappings, env);

    expect(registry.get('100')!.platform).toBe('github');
    expect(registry.get('200')!.platform).toBe('gitea');
    expect(registry.get('100')).not.toBe(registry.get('200'));
  });
});

describe('parseIssueUrlFromAnyProvider', () => {
  const github = new GitHubProvider('token');
  const gitea = new GiteaProvider('https://gitea.example.com', 'token');
  const providers = [github, gitea];

  it('matches GitHub URL with GitHub provider', () => {
    const result = parseIssueUrlFromAnyProvider(
      'https://github.com/owner/repo/issues/1',
      providers
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe(github);
    expect(result!.owner).toBe('owner');
    expect(result!.repo).toBe('repo');
    expect(result!.issueNumber).toBe(1);
  });

  it('matches Gitea URL with Gitea provider', () => {
    const result = parseIssueUrlFromAnyProvider(
      'https://gitea.example.com/org/repo/issues/5',
      providers
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe(gitea);
    expect(result!.owner).toBe('org');
    expect(result!.repo).toBe('repo');
    expect(result!.issueNumber).toBe(5);
  });

  it('returns null for unrecognized URLs', () => {
    const result = parseIssueUrlFromAnyProvider(
      'https://gitlab.com/owner/repo/issues/1',
      providers
    );
    expect(result).toBeNull();
  });

  it('returns null for null/undefined/empty', () => {
    expect(parseIssueUrlFromAnyProvider(null, providers)).toBeNull();
    expect(parseIssueUrlFromAnyProvider(undefined, providers)).toBeNull();
    expect(parseIssueUrlFromAnyProvider('', providers)).toBeNull();
  });

  it('returns null when no providers given', () => {
    expect(parseIssueUrlFromAnyProvider('https://github.com/o/r/issues/1', [])).toBeNull();
  });
});
