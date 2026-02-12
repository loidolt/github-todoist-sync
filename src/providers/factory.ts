import type { Env } from '../types/env.js';
import type { IssueProvider, OrgConfig, OrgMappings, ProviderRegistry } from './types.js';
import { GitHubProvider } from './github.js';
import { GiteaProvider } from './gitea.js';

/**
 * Create an issue provider from an org config entry
 */
export function createProvider(config: OrgConfig, env: Env): IssueProvider {
  if (config.platform === 'gitea') {
    const tokens: Record<string, string> = env.GITEA_TOKENS
      ? (JSON.parse(env.GITEA_TOKENS) as Record<string, string>)
      : {};
    const token = tokens[config.instanceUrl];
    if (!token) {
      throw new Error(
        `No Gitea token found for instance: ${config.instanceUrl}. ` +
          'Set GITEA_TOKENS as JSON mapping instance URLs to API tokens.'
      );
    }
    return new GiteaProvider(config.instanceUrl, token);
  }

  // Default: GitHub
  return new GitHubProvider(env.GITHUB_TOKEN);
}

/**
 * Create a provider registry from org mappings.
 * Deduplicates providers: the same platform+instanceUrl shares one provider instance.
 */
export function createProviderRegistry(
  orgMappings: OrgMappings,
  env: Env
): ProviderRegistry {
  const registry: ProviderRegistry = new Map();
  const providerCache = new Map<string, IssueProvider>();

  for (const [projectId, config] of orgMappings) {
    const cacheKey = `${config.platform}:${config.instanceUrl}`;
    if (!providerCache.has(cacheKey)) {
      providerCache.set(cacheKey, createProvider(config, env));
    }
    registry.set(projectId, providerCache.get(cacheKey)!);
  }

  return registry;
}
