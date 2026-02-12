import type { Env } from '../types/env.js';
import type { CompletedTask } from '../types/todoist.js';
import type { Logger } from '../logging/logger.js';
import type { IssueProvider } from '../providers/types.js';
import { parseIssueUrlFromAnyProvider } from '../providers/url-parsing.js';
import { fetchTodoistTaskById, storeTaskMapping } from '../todoist/tasks.js';

/**
 * Resolved issue URL with source information
 */
export interface ResolvedIssueUrl {
  url: string;
  source: 'kv' | 'description' | 'content_parse' | 'rest_api';
}

/**
 * Resolve the issue URL for a completed Todoist task
 * Uses multiple fallback mechanisms for reliability:
 * 1. KV mapping (fastest, most reliable for new tasks)
 * 2. Description from completed/get_all response (multi-provider parsing)
 * 3. Content parsing + project hierarchy reconstruction
 * 4. REST API fetch (expensive last resort)
 */
export async function resolveIssueUrlForCompletedTask(
  env: Env,
  completedTask: CompletedTask,
  providers: Iterable<IssueProvider>,
  logger: Logger
): Promise<ResolvedIssueUrl | null> {
  const taskId = completedTask.id;
  const taskContent = completedTask.content ?? '';
  const taskLogger = logger.child({ taskId });

  // Layer 1: KV Mapping (fastest, most reliable)
  try {
    const kvUrl = await env.WEBHOOK_CACHE.get(`task:${taskId}`);
    if (kvUrl) {
      taskLogger.debug('Issue URL resolved via KV mapping');
      return { url: kvUrl, source: 'kv' };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    taskLogger.warn(`KV lookup failed: ${message}`);
  }

  // Layer 2: Description from completed/get_all response (multi-provider)
  if (completedTask.description) {
    const parsed = parseIssueUrlFromAnyProvider(completedTask.description, providers);
    if (parsed) {
      taskLogger.debug('Issue URL resolved via description');
      return { url: parsed.url, source: 'description' };
    }
  }

  // Layer 3: Parse from content + project hierarchy
  // Use _webBaseUrl from enriched task data (platform-aware)
  const contentMatch = taskContent.match(/^\[#(\d+)\]/);
  if (contentMatch && completedTask._fullRepo) {
    const issueNumber = contentMatch[1];
    const webBaseUrl = completedTask._webBaseUrl ?? 'https://github.com';
    const url = `${webBaseUrl}/${completedTask._fullRepo}/issues/${issueNumber}`;
    taskLogger.debug('Issue URL reconstructed from content + project hierarchy');
    return { url, source: 'content_parse' };
  }

  // Layer 4: Fetch task directly via REST API (expensive last resort)
  try {
    const task = await fetchTodoistTaskById(env, taskId);
    if (task?.description) {
      const parsed = parseIssueUrlFromAnyProvider(task.description, providers);
      if (parsed) {
        taskLogger.debug('Issue URL resolved via REST API fetch');

        // Opportunistically store in KV for future lookups
        try {
          await storeTaskMapping(env, taskId, parsed.url);
        } catch (kvError) {
          taskLogger.warn('Failed to store KV mapping', { error: kvError });
        }

        return { url: parsed.url, source: 'rest_api' };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    taskLogger.warn(`REST API fetch failed: ${message}`);
  }

  // Log detailed diagnostic information
  taskLogger.warn('Could not resolve issue URL from any source', {
    content: taskContent.substring(0, 100),
    hasDescription: !!completedTask.description,
    descriptionPreview: completedTask.description?.substring(0, 100) ?? null,
    fullRepo: completedTask._fullRepo ?? null,
    contentHasIssuePrefix: /^\[#\d+\]/.test(taskContent),
  });
  return null;
}
