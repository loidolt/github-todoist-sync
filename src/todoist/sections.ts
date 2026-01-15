import type { Env } from '../types/env.js';
import type { TodoistSection, SectionCache } from '../types/todoist.js';
import type { Logger } from '../logging/logger.js';
import { CONSTANTS } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';
import { getTodoistHeaders } from './client.js';

/**
 * Section ID to name lookup cache
 */
export type SectionIdToNameCache = Map<string, Map<string, string>>;

/**
 * Fetch all sections for a Todoist project
 */
export async function fetchSectionsForProject(
  env: Env,
  projectId: string
): Promise<TodoistSection[]> {
  return withRetry(async () => {
    const response = await fetch(
      `${CONSTANTS.TODOIST_API_BASE}/rest/v2/sections?project_id=${projectId}`,
      {
        headers: getTodoistHeaders(env),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<TodoistSection[]>;
  });
}

/**
 * Fetch sections for multiple projects and build caches
 */
export async function fetchSectionsForProjects(
  env: Env,
  projectIds: string[],
  logger?: Logger
): Promise<{ sectionCache: SectionCache; sectionIdToName: SectionIdToNameCache }> {
  const sectionCache: SectionCache = new Map();
  const sectionIdToName: SectionIdToNameCache = new Map();

  for (const projectId of projectIds) {
    try {
      const sections = await fetchSectionsForProject(env, projectId);

      const nameToId = new Map<string, string>();
      const idToName = new Map<string, string>();

      for (const section of sections) {
        nameToId.set(section.name, String(section.id));
        idToName.set(String(section.id), section.name);
      }

      sectionCache.set(String(projectId), nameToId);
      sectionIdToName.set(String(projectId), idToName);
    } catch (error) {
      if (logger) {
        logger.error(`Failed to fetch sections for project ${projectId}`, error);
      }
      sectionCache.set(String(projectId), new Map());
      sectionIdToName.set(String(projectId), new Map());
    }
  }

  const totalSections = Array.from(sectionCache.values()).reduce(
    (sum, m) => sum + m.size,
    0
  );

  if (logger) {
    logger.info(`Fetched ${totalSections} sections across ${projectIds.length} projects`, {
      totalSections,
      projectCount: projectIds.length,
    });
  }

  return { sectionCache, sectionIdToName };
}

/**
 * Create a new section in a Todoist project
 */
export async function createTodoistSection(
  env: Env,
  projectId: string,
  name: string
): Promise<TodoistSection> {
  return withRetry(async () => {
    const response = await fetch(`${CONSTANTS.TODOIST_API_BASE}/rest/v2/sections`, {
      method: 'POST',
      headers: {
        ...getTodoistHeaders(env),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ project_id: projectId, name }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<TodoistSection>;
  });
}

/**
 * Get or create a section for a milestone name
 * Uses cache to minimize API calls
 */
export async function getOrCreateSection(
  env: Env,
  projectId: string,
  milestoneName: string,
  sectionCache: SectionCache,
  logger?: Logger
): Promise<string> {
  const projectIdStr = String(projectId);
  const sectionLogger = logger?.child({ projectId, section: milestoneName });

  // Check cache
  let projectSections = sectionCache.get(projectIdStr);
  if (projectSections?.has(milestoneName)) {
    return projectSections.get(milestoneName)!;
  }

  // Refresh cache from API
  try {
    const sections = await fetchSectionsForProject(env, projectId);
    projectSections = new Map();
    for (const section of sections) {
      projectSections.set(section.name, String(section.id));
    }
    sectionCache.set(projectIdStr, projectSections);

    if (projectSections.has(milestoneName)) {
      return projectSections.get(milestoneName)!;
    }
  } catch (error) {
    sectionLogger?.error('Failed to refresh sections', error);
  }

  // Create new section
  try {
    sectionLogger?.debug('Creating new section');
    const section = await createTodoistSection(env, projectId, milestoneName);

    if (!projectSections) {
      projectSections = new Map();
      sectionCache.set(projectIdStr, projectSections);
    }
    projectSections.set(milestoneName, String(section.id));

    return String(section.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Handle race condition
    if (message.includes('already exists') || message.includes('409')) {
      sectionLogger?.debug('Section already exists (race condition), refreshing cache');

      sectionCache.delete(projectIdStr);

      const sections = await fetchSectionsForProject(env, projectId);
      const newProjectSections = new Map<string, string>();
      for (const section of sections) {
        newProjectSections.set(section.name, String(section.id));
      }
      sectionCache.set(projectIdStr, newProjectSections);

      if (newProjectSections.has(milestoneName)) {
        return newProjectSections.get(milestoneName)!;
      }

      sectionLogger?.warn('Section not found after 409 conflict - unexpected state');
    }
    throw error;
  }
}

/**
 * Update a Todoist task's section
 */
export async function updateTodoistTaskSection(
  env: Env,
  taskId: string,
  sectionId: string | null
): Promise<void> {
  return withRetry(async () => {
    const response = await fetch(
      `${CONSTANTS.TODOIST_API_BASE}/rest/v2/tasks/${taskId}`,
      {
        method: 'POST',
        headers: {
          ...getTodoistHeaders(env),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ section_id: sectionId }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }
  });
}
