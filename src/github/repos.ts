import type { Env } from '../types/env.js';
import type { GitHubRepo } from '../types/github.js';
import { CONSTANTS } from '../config/constants.js';
import { getGitHubHeaders } from './client.js';

/**
 * Fetch all repositories for a GitHub organization
 */
export async function* fetchOrgRepos(
  env: Env,
  org: string
): AsyncGenerator<GitHubRepo, void, unknown> {
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      per_page: String(CONSTANTS.PER_PAGE),
      page: String(page),
      sort: 'name',
    });

    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/orgs/${org}/repos?${params}`,
      {
        headers: getGitHubHeaders(env),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    const repos = (await response.json()) as GitHubRepo[];

    for (const repo of repos) {
      // Skip archived and disabled repos
      if (repo.archived || repo.disabled) continue;
      yield repo;
    }

    if (repos.length < CONSTANTS.PER_PAGE) break;
    page++;
  }
}

/**
 * Fetch all repositories for a GitHub user
 */
export async function* fetchUserRepos(
  env: Env,
  username: string
): AsyncGenerator<GitHubRepo, void, unknown> {
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      per_page: String(CONSTANTS.PER_PAGE),
      page: String(page),
      sort: 'name',
      type: 'owner',
    });

    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/users/${username}/repos?${params}`,
      {
        headers: getGitHubHeaders(env),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    const repos = (await response.json()) as GitHubRepo[];

    for (const repo of repos) {
      if (repo.archived || repo.disabled) continue;
      yield repo;
    }

    if (repos.length < CONSTANTS.PER_PAGE) break;
    page++;
  }
}
