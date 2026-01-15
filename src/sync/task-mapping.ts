import type { Env } from '../types/env.js';
import type { CompletedTask } from '../types/todoist.js';
import type { Logger } from '../logging/logger.js';
import { parseGitHubUrl } from '../utils/helpers.js';
import { fetchTodoistTaskById, storeTaskMapping } from '../todoist/tasks.js';

/**
 * Resolved GitHub URL with source information
 */
export interface ResolvedGitHubUrl {
  url: string;
  source: 'kv' | 'description' | 'content_parse' | 'rest_api';
}

/**
 * Resolve the GitHub issue URL for a completed Todoist task
 * Uses multiple fallback mechanisms for reliability:
 * 1. KV mapping (fastest, most reliable for new tasks)
 * 2. Description from completed/get_all response
 * 3. Content parsing + project hierarchy reconstruction
 * 4. REST API fetch (expensive last resort)
 */
export async function resolveGitHubUrlForCompletedTask(
  env: Env,
  completedTask: CompletedTask,
  logger: Logger
): Promise<ResolvedGitHubUrl | null> {
  const taskId = completedTask.id;
  const taskContent = completedTask.content ?? '';
  const taskLogger = logger.child({ taskId });

  // Layer 1: KV Mapping (fastest, most reliable)
  try {
    const kvUrl = await env.WEBHOOK_CACHE.get(`task:${taskId}`);
    if (kvUrl) {
      taskLogger.debug('GitHub URL resolved via KV mapping');
      return { url: kvUrl, source: 'kv' };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    taskLogger.warn(`KV lookup failed: ${message}`);
  }

  // Layer 2: Description from completed/get_all response
  if (completedTask.description) {
    const githubInfo = parseGitHubUrl(completedTask.description);
    if (githubInfo) {
      taskLogger.debug('GitHub URL resolved via description');
      return { url: githubInfo.url, source: 'description' };
    }
  }

  // Layer 3: Parse from content + project hierarchy
  const contentMatch = taskContent.match(/^\[#(\d+)\]/);
  if (contentMatch && completedTask._fullRepo) {
    const issueNumber = contentMatch[1];
    const url = `https://github.com/${completedTask._fullRepo}/issues/${issueNumber}`;
    taskLogger.debug('GitHub URL reconstructed from content + project hierarchy');
    return { url, source: 'content_parse' };
  }

  // Layer 4: Fetch task directly via REST API (expensive last resort)
  try {
    const task = await fetchTodoistTaskById(env, taskId);
    if (task?.description) {
      const githubInfo = parseGitHubUrl(task.description);
      if (githubInfo) {
        taskLogger.debug('GitHub URL resolved via REST API fetch');

        // Opportunistically store in KV for future lookups
        try {
          await storeTaskMapping(env, taskId, githubInfo.url);
        } catch (kvError) {
          taskLogger.warn('Failed to store KV mapping', { error: kvError });
        }

        return { url: githubInfo.url, source: 'rest_api' };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    taskLogger.warn(`REST API fetch failed: ${message}`);
  }

  // Log detailed diagnostic information to help debug URL resolution failures
  taskLogger.warn('Could not resolve GitHub URL from any source', {
    content: taskContent.substring(0, 100),
    hasDescription: !!completedTask.description,
    descriptionPreview: completedTask.description?.substring(0, 100) ?? null,
    fullRepo: completedTask._fullRepo ?? null,
    contentHasIssuePrefix: /^\[#\d+\]/.test(taskContent),
  });
  return null;
}
