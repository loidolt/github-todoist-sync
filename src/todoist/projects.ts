import type { Env } from '../types/env.js';
import type {
  TodoistProject,
  ProjectHierarchy,
  ParentProject,
  SubProject,
} from '../types/todoist.js';
import type { Logger } from '../logging/logger.js';
import { CONSTANTS } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';
import { validateTodoistProjects, isObject, isArray, ValidationError } from '../utils/validation.js';
import { getTodoistHeaders } from './client.js';

/**
 * Parse ORG_MAPPINGS environment variable
 * Format: {"todoist-project-id": "github-org", ...}
 * Returns Map of projectId -> githubOrg
 *
 * @param env - Environment with ORG_MAPPINGS variable
 * @param logger - Logger for structured logging
 * @returns Map of Todoist project ID to GitHub org name
 */
export function parseOrgMappings(env: Env, logger: Logger): Map<string, string> {
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

    // Validate all values are strings
    const mappings: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        throw new ValidationError(
          `ORG_MAPPINGS value for key "${key}" must be a string`,
          `ORG_MAPPINGS.${key}`,
          'string',
          typeof value
        );
      }
      mappings[key] = value;
    }

    const map = new Map(Object.entries(mappings));
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
 * - Parent projects (mapped via ORG_MAPPINGS) represent GitHub organizations
 * - Sub-projects (children of parent projects) represent GitHub repositories
 *
 * @param projects - Array of Todoist projects from the Sync API
 * @param orgMappings - Map of Todoist project ID to GitHub org name
 * @param logger - Logger for structured logging
 * @returns ProjectHierarchy with parent projects, sub-projects, and repo-to-project mapping
 */
export function buildProjectHierarchy(
  projects: TodoistProject[],
  orgMappings: Map<string, string>,
  logger: Logger
): ProjectHierarchy {
  const parentProjects = new Map<string, ParentProject>();
  const subProjects = new Map<string, SubProject>();
  const repoToProject = new Map<string, string>();

  // First pass: identify parent projects (those in org mappings)
  for (const project of projects) {
    const projectId = String(project.id);
    const githubOrg = orgMappings.get(projectId);

    if (githubOrg) {
      parentProjects.set(projectId, {
        id: projectId,
        name: project.name,
        githubOrg,
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
      const fullRepo = `${parent.githubOrg}/${repoName}`;

      subProjects.set(projectId, {
        id: projectId,
        name: repoName,
        parentId,
        githubOrg: parent.githubOrg,
        repoName,
        fullRepo,
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
