import type { Env } from '../types/env.js';
import type { GitHubMilestone } from '../types/github.js';
import { CONSTANTS } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';
import { getGitHubHeaders } from './client.js';

/**
 * Milestone cache structure
 */
export interface MilestoneCaches {
  titleToNumber: Map<string, number>;
  numberToTitle: Map<number, string>;
}

/**
 * Repository-keyed milestone cache
 */
export type MilestoneCache = Map<string, MilestoneCaches>;

/**
 * Fetch all milestones for a GitHub repository
 */
export async function fetchMilestonesForRepo(
  env: Env,
  owner: string,
  repo: string
): Promise<GitHubMilestone[]> {
  return withRetry(async () => {
    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/repos/${owner}/${repo}/milestones?state=all&per_page=100`,
      {
        headers: getGitHubHeaders(env),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<GitHubMilestone[]>;
  });
}

/**
 * Fetch milestones for a repo and build caches
 * Uses existing cache if available
 */
export async function getMilestoneCaches(
  env: Env,
  owner: string,
  repo: string,
  existingCache?: MilestoneCache | null
): Promise<MilestoneCaches> {
  const repoKey = `${owner}/${repo}`;

  // Return existing cache if available
  if (existingCache?.has(repoKey)) {
    return existingCache.get(repoKey)!;
  }

  const milestones = await fetchMilestonesForRepo(env, owner, repo);

  const titleToNumber = new Map<string, number>();
  const numberToTitle = new Map<number, string>();

  for (const milestone of milestones) {
    titleToNumber.set(milestone.title, milestone.number);
    numberToTitle.set(milestone.number, milestone.title);
  }

  const caches: MilestoneCaches = { titleToNumber, numberToTitle };

  if (existingCache) {
    existingCache.set(repoKey, caches);
  }

  return caches;
}

/**
 * Get milestone number from title for a repo
 * Returns null if milestone doesn't exist
 */
export async function getMilestoneNumber(
  env: Env,
  owner: string,
  repo: string,
  milestoneTitle: string,
  milestoneCache?: MilestoneCache | null
): Promise<number | null> {
  const caches = await getMilestoneCaches(env, owner, repo, milestoneCache);
  return caches.titleToNumber.get(milestoneTitle) ?? null;
}

/**
 * Get milestone title from number for a repo
 * Returns null if milestone doesn't exist
 */
export async function getMilestoneTitle(
  env: Env,
  owner: string,
  repo: string,
  milestoneNumber: number,
  milestoneCache?: MilestoneCache | null
): Promise<string | null> {
  const caches = await getMilestoneCaches(env, owner, repo, milestoneCache);
  return caches.numberToTitle.get(milestoneNumber) ?? null;
}

/**
 * Update a GitHub issue's milestone
 * milestoneNumber can be null to clear milestone
 */
export async function updateGitHubIssueMilestone(
  env: Env,
  owner: string,
  repo: string,
  issueNumber: number,
  milestoneNumber: number | null
): Promise<void> {
  return withRetry(async () => {
    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          ...getGitHubHeaders(env),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ milestone: milestoneNumber }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }
  });
}
