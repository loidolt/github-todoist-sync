import type { Env } from '../types/env.js';
import type { TodoistSyncResponse } from '../types/todoist.js';
import type { Logger } from '../logging/logger.js';
import { CONSTANTS } from '../config/constants.js';
import { getTodoistHeaders } from './client.js';
import { storeTaskMapping } from './tasks.js';
import { formatTaskContent } from '../utils/helpers.js';

/**
 * Task data for batch creation
 */
export interface BatchTaskData {
  title: string;
  issueNumber: number;
  issueUrl: string;
  projectId: string;
  sectionId?: string | null;
}

/**
 * Batch creation result
 */
export interface BatchCreateResult {
  success: number;
  failed: number;
  errors: Array<{ uuid?: string; batch?: number; status?: string; error?: string }>;
}

/**
 * Batch create multiple Todoist tasks using the Sync API
 */
export async function batchCreateTodoistTasks(
  env: Env,
  tasks: BatchTaskData[],
  logger?: Logger
): Promise<BatchCreateResult> {
  if (tasks.length === 0) {
    return { success: 0, failed: 0, errors: [] };
  }

  const results: BatchCreateResult = { success: 0, failed: 0, errors: [] };
  const batchSize = CONSTANTS.BATCH_TASK_LIMIT;

  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;

    // Build Sync API commands and track temp_id -> issueUrl
    const tempIdToIssueUrl = new Map<string, string>();
    const commands = batch.map((task, idx) => {
      const tempId = `temp_${i + idx}_${Date.now()}`;
      tempIdToIssueUrl.set(tempId, task.issueUrl);
      return {
        type: 'item_add',
        temp_id: tempId,
        uuid: crypto.randomUUID(),
        args: {
          content: formatTaskContent(task.issueNumber, task.title),
          description: task.issueUrl,
          project_id: task.projectId,
          ...(task.sectionId && { section_id: task.sectionId }),
        },
      };
    });

    try {
      const response = await fetch(`${CONSTANTS.TODOIST_API_BASE}/sync/v9/sync`, {
        method: 'POST',
        headers: {
          ...getTodoistHeaders(env),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ commands }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as TodoistSyncResponse;

      // Check sync_status for individual command results
      if (data.sync_status) {
        for (const [uuid, status] of Object.entries(data.sync_status)) {
          if (status === 'ok') {
            results.success++;
          } else {
            results.failed++;
            results.errors.push({ uuid, status });
          }
        }
      } else {
        // If no sync_status, assume all succeeded
        results.success += batch.length;
      }

      // Store task ID -> GitHub URL mappings
      if (data.temp_id_mapping) {
        for (const [tempId, taskId] of Object.entries(data.temp_id_mapping)) {
          const issueUrl = tempIdToIssueUrl.get(tempId);
          if (issueUrl && taskId) {
            await storeTaskMapping(env, String(taskId), issueUrl, 2, logger);
          }
        }
      }
    } catch (error) {
      if (logger) {
        logger.error(`Batch task creation failed`, error, { batch: batchNumber, batchSize: batch.length });
      }
      results.failed += batch.length;
      results.errors.push({
        batch: i,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * Section data for batch creation
 */
export interface BatchSectionData {
  projectId: string;
  name: string;
}

/**
 * Batch create multiple sections using the Sync API
 * Returns a map of "projectId:name" -> sectionId
 */
export async function batchCreateSections(
  env: Env,
  sections: BatchSectionData[],
  logger?: Logger
): Promise<Map<string, string>> {
  const createdSections = new Map<string, string>();

  if (sections.length === 0) {
    return createdSections;
  }

  const timestamp = Date.now();
  const commands = sections.map((section, idx) => ({
    type: 'section_add',
    temp_id: `section_temp_${idx}_${timestamp}`,
    uuid: crypto.randomUUID(),
    args: {
      name: section.name,
      project_id: section.projectId,
    },
  }));

  try {
    const response = await fetch(`${CONSTANTS.TODOIST_API_BASE}/sync/v9/sync`, {
      method: 'POST',
      headers: {
        ...getTodoistHeaders(env),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ commands }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as TodoistSyncResponse;

    // Map temp_ids to real IDs
    if (data.temp_id_mapping) {
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        if (!section) continue;

        for (const [tid, realId] of Object.entries(data.temp_id_mapping)) {
          if (tid.startsWith(`section_temp_${i}_`)) {
            const key = `${section.projectId}:${section.name}`;
            createdSections.set(key, String(realId));
            break;
          }
        }
      }
    }

    // Also check sections in response
    if (data.sections) {
      for (const section of data.sections) {
        const key = `${section.project_id}:${section.name}`;
        createdSections.set(key, String(section.id));
      }
    }

    if (logger) {
      logger.info(`Batch created ${sections.length} section(s)`, { count: sections.length });
    }
  } catch (error) {
    if (logger) {
      logger.error('Batch section creation failed', error, { count: sections.length });
    }
  }

  return createdSections;
}
