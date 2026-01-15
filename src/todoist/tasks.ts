import type { Env } from '../types/env.js';
import type { TodoistTask, TodoistSyncTask } from '../types/todoist.js';
import type { Logger } from '../logging/logger.js';
import { CONSTANTS } from '../config/constants.js';
import { withRetry, sleep } from '../utils/retry.js';
import { getTodoistHeaders } from './client.js';
import { formatTaskContent } from '../utils/helpers.js';

/**
 * Create a single Todoist task via REST API
 */
export async function createTodoistTask(
  env: Env,
  options: {
    title: string;
    issueNumber: number;
    issueUrl: string;
    projectId: string;
    sectionId?: string | null;
  },
  logger?: Logger
): Promise<TodoistTask> {
  const { title, issueNumber, issueUrl, projectId, sectionId } = options;

  if (!projectId) {
    throw new Error('projectId is required - ensure ORG_MAPPINGS is configured');
  }

  const taskData: Record<string, unknown> = {
    content: formatTaskContent(issueNumber, title),
    description: issueUrl,
    project_id: projectId,
  };

  if (sectionId) {
    taskData.section_id = sectionId;
  }

  const task = await withRetry(async () => {
    const response = await fetch(`${CONSTANTS.TODOIST_API_BASE}/rest/v2/tasks`, {
      method: 'POST',
      headers: {
        ...getTodoistHeaders(env),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(taskData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<TodoistTask>;
  });

  // Store mapping from task ID to GitHub issue URL for completed task processing
  // This mapping is critical for closing GitHub issues when Todoist tasks are completed
  if (task?.id) {
    const mappingStored = await storeTaskMapping(env, task.id, issueUrl, 2, logger);
    if (!mappingStored) {
      const errorMsg =
        `Failed to store KV mapping for task ${task.id} -> ${issueUrl}. ` +
        `Completing this task in Todoist may not close the GitHub issue.`;
      if (logger) {
        logger.error(errorMsg, undefined, { taskId: task.id, issueUrl });
      }
    }
  }

  return task;
}

/**
 * Store task ID to GitHub URL mapping in KV with retry logic
 */
export async function storeTaskMapping(
  env: Env,
  taskId: string,
  issueUrl: string,
  maxRetries = 2,
  logger?: Logger
): Promise<boolean> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await env.WEBHOOK_CACHE.put(`task:${taskId}`, issueUrl, {
        expirationTtl: 60 * 60 * 24 * 365, // 1 year TTL
      });

      // Verify write succeeded
      const verified = await env.WEBHOOK_CACHE.get(`task:${taskId}`);
      if (verified === issueUrl) {
        if (attempt > 0 && logger) {
          logger.debug(`KV mapping stored successfully on retry`, { taskId, attempt: attempt + 1 });
        }
        return true;
      }
      if (logger) {
        logger.warn(`KV verification mismatch`, { taskId, attempt: attempt + 1 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (logger) {
        logger.warn(`KV store attempt failed: ${message}`, { taskId, attempt: attempt + 1 });
      }
    }

    if (attempt < maxRetries) {
      await sleep(100 * (attempt + 1));
    }
  }

  if (logger) {
    logger.error(`KV storage failed after ${maxRetries + 1} attempts`, undefined, { taskId });
  }
  return false;
}

/**
 * Find a Todoist task by its GitHub issue URL in the description
 */
export async function findTodoistTaskByIssueUrl(
  env: Env,
  issueUrl: string
): Promise<TodoistTask | undefined> {
  return withRetry(async () => {
    const filterQuery = encodeURIComponent(`search: ${issueUrl}`);
    const response = await fetch(
      `${CONSTANTS.TODOIST_API_BASE}/rest/v2/tasks?filter=${filterQuery}`,
      {
        headers: getTodoistHeaders(env),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }

    const tasks = (await response.json()) as TodoistTask[];
    // Double-check the description match since filter is fuzzy
    return tasks.find((t) => t.description?.includes(issueUrl));
  });
}

/**
 * Check if a Todoist task already exists for the given GitHub issue URL
 */
export async function taskExistsForIssue(
  env: Env,
  issueUrl: string,
  logger?: Logger
): Promise<boolean> {
  try {
    const task = await findTodoistTaskByIssueUrl(env, issueUrl);
    return task !== null && task !== undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger) {
      logger.error(`Failed to check for existing task: ${message}`, error);
    }
    return false;
  }
}

/**
 * Fetch a single Todoist task by ID using REST API
 */
export async function fetchTodoistTaskById(
  env: Env,
  taskId: string
): Promise<TodoistTask | null> {
  return withRetry(
    async () => {
      const response = await fetch(
        `${CONSTANTS.TODOIST_API_BASE}/rest/v2/tasks/${taskId}`,
        {
          headers: getTodoistHeaders(env),
        }
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Todoist REST API error: ${response.status} - ${errorText}`);
      }

      return response.json() as Promise<TodoistTask>;
    },
    { maxRetries: 2 }
  );
}

/**
 * Complete (close) a Todoist task
 */
export async function completeTodoistTask(env: Env, taskId: string): Promise<void> {
  return withRetry(async () => {
    const response = await fetch(
      `${CONSTANTS.TODOIST_API_BASE}/rest/v2/tasks/${taskId}/close`,
      {
        method: 'POST',
        headers: getTodoistHeaders(env),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }
  });
}

/**
 * Update a Todoist task
 */
export async function updateTodoistTask(
  env: Env,
  taskId: string,
  updates: Partial<Pick<TodoistTask, 'content' | 'description' | 'section_id'>>
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
        body: JSON.stringify(updates),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }
  });
}

/**
 * Reopen a completed Todoist task
 */
export async function reopenTodoistTask(env: Env, taskId: string): Promise<void> {
  return withRetry(async () => {
    const response = await fetch(
      `${CONSTANTS.TODOIST_API_BASE}/rest/v2/tasks/${taskId}/reopen`,
      {
        method: 'POST',
        headers: getTodoistHeaders(env),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }
  });
}

/**
 * Fetch all tasks for specified projects using Todoist Sync API
 * Returns a Map of issueUrl -> { taskId, projectId }
 */
export async function fetchExistingTasksForProjects(
  env: Env,
  projectIds: string[],
  logger?: Logger
): Promise<Map<string, { taskId: string; projectId: string }>> {
  const existingTasks = new Map<string, { taskId: string; projectId: string }>();

  const response = await fetch(`${CONSTANTS.TODOIST_API_BASE}/sync/v9/sync`, {
    method: 'POST',
    headers: {
      ...getTodoistHeaders(env),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      sync_token: '*',
      resource_types: '["items"]',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as { items?: TodoistSyncTask[] };
  const projectIdSet = new Set(projectIds.map(String));

  for (const task of data.items ?? []) {
    const taskProjectId = String(task.project_id);
    if (!projectIdSet.has(taskProjectId)) continue;

    if (task.description) {
      const githubUrlMatch = task.description.match(
        /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/
      );
      if (githubUrlMatch) {
        existingTasks.set(githubUrlMatch[0], {
          taskId: String(task.id),
          projectId: taskProjectId,
        });
      }
    }
  }

  if (logger) {
    logger.info(
      `Found ${existingTasks.size} existing tasks with GitHub URLs across ${projectIds.length} projects`,
      { taskCount: existingTasks.size, projectCount: projectIds.length }
    );
  }

  return existingTasks;
}
