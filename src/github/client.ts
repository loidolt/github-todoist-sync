import type { Env } from '../types/env.js';
import { CONSTANTS } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';

/**
 * GitHub rate limit information extracted from response headers
 */
export interface GitHubRateLimit {
  /** Maximum requests allowed per hour */
  limit: number;
  /** Remaining requests in current window */
  remaining: number;
  /** Unix timestamp when the rate limit resets */
  reset: number;
  /** Resource type (core, search, graphql, etc.) */
  resource: string;
  /** ISO timestamp when the rate limit resets */
  resetAt: string;
  /** Whether we're close to the rate limit (< 10% remaining) */
  isLow: boolean;
}

/**
 * Global rate limit state - updated with each API call
 * Tracks the most recent rate limit info from GitHub
 */
let lastRateLimit: GitHubRateLimit | null = null;

/**
 * Get the last known rate limit info
 * Returns null if no API calls have been made yet
 */
export function getLastRateLimit(): GitHubRateLimit | null {
  return lastRateLimit;
}

/**
 * Reset the rate limit tracking (useful for testing)
 */
export function resetRateLimitTracking(): void {
  lastRateLimit = null;
}

/**
 * Extract rate limit info from GitHub response headers
 */
function extractRateLimit(response: Response): GitHubRateLimit | null {
  const limit = response.headers.get('x-ratelimit-limit');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  const resource = response.headers.get('x-ratelimit-resource');

  if (!limit || !remaining || !reset) {
    return null;
  }

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
    isLow: remainingNum < limitNum * 0.1, // < 10% remaining
  };
}

/**
 * Base GitHub API request headers
 */
export function getGitHubHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'GitHub-Todoist-Sync-Worker',
  };
}

/**
 * Make a GitHub API request with retry logic and rate limit tracking
 *
 * Tracks rate limit headers from GitHub responses and makes them available
 * via getLastRateLimit(). Logs warnings when rate limits are low.
 */
export async function githubFetch<T>(
  env: Env,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  return withRetry(async () => {
    const url = path.startsWith('http') ? path : `${CONSTANTS.GITHUB_API_BASE}${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        ...getGitHubHeaders(env),
        ...options.headers,
      },
    });

    // Extract and store rate limit info
    const rateLimit = extractRateLimit(response);
    if (rateLimit) {
      lastRateLimit = rateLimit;

      // Log warning if rate limit is low
      if (rateLimit.isLow) {
        console.warn(
          `GitHub rate limit low: ${rateLimit.remaining}/${rateLimit.limit} remaining, resets at ${rateLimit.resetAt}`
        );
      }
    }

    if (!response.ok) {
      const errorText = await response.text();

      // Include rate limit info in error message for 403 (rate limit exceeded)
      if (response.status === 403 && rateLimit) {
        throw new Error(
          `GitHub API rate limit exceeded: ${rateLimit.remaining}/${rateLimit.limit} remaining, resets at ${rateLimit.resetAt}`
        );
      }

      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  });
}

/**
 * Make a GitHub API request that returns void (e.g., DELETE)
 * Includes rate limit tracking
 */
export async function githubFetchVoid(
  env: Env,
  path: string,
  options: RequestInit = {}
): Promise<void> {
  return withRetry(async () => {
    const url = path.startsWith('http') ? path : `${CONSTANTS.GITHUB_API_BASE}${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        ...getGitHubHeaders(env),
        ...options.headers,
      },
    });

    // Extract and store rate limit info
    const rateLimit = extractRateLimit(response);
    if (rateLimit) {
      lastRateLimit = rateLimit;

      if (rateLimit.isLow) {
        console.warn(
          `GitHub rate limit low: ${rateLimit.remaining}/${rateLimit.limit} remaining, resets at ${rateLimit.resetAt}`
        );
      }
    }

    if (!response.ok) {
      const errorText = await response.text();

      if (response.status === 403 && rateLimit) {
        throw new Error(
          `GitHub API rate limit exceeded: ${rateLimit.remaining}/${rateLimit.limit} remaining, resets at ${rateLimit.resetAt}`
        );
      }

      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }
  });
}
