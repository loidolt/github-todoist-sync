import type { Env } from '../types/env.js';
import type {
  TodoistProject,
  ProjectHierarchy,
  ParentProject,
  SubProject,
} from '../types/todoist.js';
import type { Logger } from '../logging/logger.js';
import type { OrgConfig, OrgMappings, Platform } from '../providers/types.js';
import { CONSTANTS } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';
import { validateTodoistProjects, isObject, isArray, ValidationError } from '../utils/validation.js';
import { getTodoistHeaders } from './client.js';

/**
 * Parse ORG_MAPPINGS environment variable
 *
 * Supports two formats (backward compatible):
 * - String values: `{"project-id": "github-org"}` (treated as GitHub)
 * - Object values: `{"project-id": {"platform": "gitea", "org": "org-name", "instanceUrl": "https://gitea.example.com"}}`
 *
 * @param env - Environment with ORG_MAPPINGS variable
 * @param logger - Logger for structured logging
 * @returns Map of Todoist project ID to OrgConfig
 */
export function parseOrgMappings(env: Env, logger: Logger): OrgMappings {
  if (!env.ORG_MAPPINGS) {
    logger.warn('No ORG_MAPPINGS configured');
    return new Map();
  }

  try {
    const parsed = JSON.parse(env.ORG_MAPPINGS) as unknown;

    // Runtime validation
    if (!isObject(parsed)) {
      throw new ValidationError(
        'ORG_MAPPINGS must be a JSON object',
        'ORG_MAPPINGS',
        'object',
        typeof parsed
      );
    }

    const map: OrgMappings = new Map();

    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        // Backward compatible: string value = GitHub org
        map.set(key, {
          org: value,
          platform: 'github',
          instanceUrl: 'https://github.com',
        });
      } else if (isObject(value)) {
        // New format: object with platform details
        const org = (value as Record<string, unknown>).org;
        if (typeof org !== 'string') {
          throw new ValidationError(
            `ORG_MAPPINGS value for key "${key}" must have a string "org" field`,
            `ORG_MAPPINGS.${key}.org`,
            'string',
            typeof org
          );
        }
        const platform = ((value as Record<string, unknown>).platform as Platform) ?? 'github';
        const instanceUrl = ((value as Record<string, unknown>).instanceUrl as string) ?? 'https://github.com';

        if (platform !== 'github' && platform !== 'gitea') {
          throw new ValidationError(
            `ORG_MAPPINGS value for key "${key}" has unsupported platform "${platform}"`,
            `ORG_MAPPINGS.${key}.platform`,
            '"github" | "gitea"',
            String(platform)
          );
        }

        map.set(key, { org, platform, instanceUrl });
      } else {
        throw new ValidationError(
          `ORG_MAPPINGS value for key "${key}" must be a string or object`,
          `ORG_MAPPINGS.${key}`,
          'string | object',
          typeof value
        );
      }
    }

    logger.info(`Loaded ${map.size} org mapping(s)`, { count: map.size });
    return map;
  } catch (error) {
    logger.error('Failed to parse ORG_MAPPINGS', error);
    return new Map();
  }
}

/**
 * Fetch all Todoist projects using Sync API
 * Includes runtime validation of response shape
 */
export async function fetchTodoistProjects(env: Env): Promise<TodoistProject[]> {
  return withRetry(async () => {
    const response = await fetch(`${CONSTANTS.TODOIST_API_BASE}/sync/v9/sync`, {
      method: 'POST',
      headers: {
        ...getTodoistHeaders(env),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        sync_token: '*',
        resource_types: '["projects"]',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as unknown;

    // Runtime validation of response
    if (!isObject(data)) {
      throw new ValidationError(
        'Todoist Sync API response must be an object',
        'response',
        'object',
        typeof data
      );
    }

    // projects may be undefined or an array
    if (data.projects === undefined || data.projects === null) {
      return [];
    }

    if (!isArray(data.projects)) {
      throw new ValidationError(
        'Todoist Sync API projects must be an array',
        'response.projects',
        'array',
        typeof data.projects
      );
    }

    // Validate each project and convert to expected shape
    const validatedProjects = validateTodoistProjects(data.projects);

    // Convert to TodoistProject type (validation already ensured required fields exist)
    return validatedProjects.map((p) => ({
      id: p.id,
      name: p.name,
      parent_id: p.parent_id,
    }));
  });
}

/**
 * Build project hierarchy from org mappings
 *
 * Creates a two-level hierarchy:
 * - Parent projects (mapped via ORG_MAPPINGS) represent organizations
 * - Sub-projects (children of parent projects) represent repositories
 *
 * @param projects - Array of Todoist projects from the Sync API
 * @param orgMappings - Map of Todoist project ID to OrgConfig
 * @param logger - Logger for structured logging
 * @returns ProjectHierarchy with parent projects, sub-projects, and repo-to-project mapping
 */
export function buildProjectHierarchy(
  projects: TodoistProject[],
  orgMappings: OrgMappings,
  logger: Logger
): ProjectHierarchy {
  const parentProjects = new Map<string, ParentProject>();
  const subProjects = new Map<string, SubProject>();
  const repoToProject = new Map<string, string>();

  // First pass: identify parent projects (those in org mappings)
  for (const project of projects) {
    const projectId = String(project.id);
    const config = orgMappings.get(projectId);

    if (config) {
      parentProjects.set(projectId, {
        id: projectId,
        name: project.name,
        org: config.org,
        platform: config.platform,
        instanceUrl: config.instanceUrl,
      });
    }
  }

  // Second pass: identify sub-projects (children of parent projects)
  for (const project of projects) {
    if (!project.parent_id) continue;

    const parentId = String(project.parent_id);
    const parent = parentProjects.get(parentId);

    if (parent) {
      const projectId = String(project.id);
      const repoName = project.name;
      const fullRepo = `${parent.org}/${repoName}`;

      subProjects.set(projectId, {
        id: projectId,
        name: repoName,
        parentId,
        org: parent.org,
        repoName,
        fullRepo,
        platform: parent.platform,
        webBaseUrl: parent.instanceUrl,
      });

      // Map full repo name to project ID for quick lookup
      repoToProject.set(fullRepo, projectId);
    }
  }

  logger.info(
    `Built hierarchy: ${parentProjects.size} parent(s), ${subProjects.size} sub-project(s)`,
    { parentCount: parentProjects.size, subProjectCount: subProjects.size }
  );

  return { parentProjects, subProjects, repoToProject };
}
