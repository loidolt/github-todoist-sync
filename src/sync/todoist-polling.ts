import type { Env } from '../types/env.js';
import type { TodoistSyncTask, ProjectHierarchy, CompletedTask } from '../types/todoist.js';
import { CONSTANTS } from '../config/constants.js';
import { getTodoistHeaders } from '../todoist/client.js';

/**
 * Result of polling Todoist for task changes
 */
export interface TodoistPollResult {
  tasks: TodoistSyncTask[];
  newSyncToken: string;
  fullSync: boolean;
}

/**
 * Poll Todoist for task changes using the Sync API
 * Filters to only tasks in sub-projects from the project hierarchy
 */
export async function pollTodoistChanges(
  env: Env,
  syncToken: string,
  projectHierarchy: ProjectHierarchy
): Promise<TodoistPollResult> {
  const response = await fetch(`${CONSTANTS.TODOIST_API_BASE}/api/v1/sync`, {
    method: 'POST',
    headers: {
      ...getTodoistHeaders(env),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      sync_token: syncToken,
      resource_types: '["items"]',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as {
    items?: TodoistSyncTask[];
    sync_token: string;
    full_sync?: boolean;
  };

  const { subProjects } = projectHierarchy;

  // Filter to only tasks in sub-projects (repos)
  const projectTasks = (data.items ?? []).filter((item) => {
    const projectId = String(item.project_id);
    return subProjects.has(projectId);
  });

  // Enrich tasks with repo info from project hierarchy
  for (const task of projectTasks) {
    const projectId = String(task.project_id);
    const subProject = subProjects.get(projectId);
    if (subProject) {
      task._org = subProject.org;
      task._repoName = subProject.repoName;
      task._fullRepo = subProject.fullRepo;
      task._webBaseUrl = subProject.webBaseUrl;
    }
  }

  return {
    tasks: projectTasks,
    newSyncToken: data.sync_token,
    fullSync: data.full_sync ?? false,
  };
}

/**
 * Poll Todoist for completed tasks
 * Needed because the Sync API does not return completed items
 *
 * v1 API endpoint: GET /api/v1/tasks/completed/by_completion_date
 * Requires both `since` and `until` parameters.
 */
export async function pollCompletedTasks(
  env: Env,
  since: string | null,
  projectHierarchy: ProjectHierarchy
): Promise<CompletedTask[]> {
  // Default `since` to buffer window ago if not set
  const sinceDate = since
    ? new Date(since)
    : new Date(Date.now() - CONSTANTS.COMPLETED_TASK_BUFFER_MINUTES * 60 * 1000);

  const params = new URLSearchParams({
    limit: '200',
    since: sinceDate.toISOString(),
    until: new Date().toISOString(),
  });

  const url = `${CONSTANTS.TODOIST_API_BASE}/api/v1/tasks/completed/by_completion_date?${params}`;

  const response = await fetch(url, {
    headers: getTodoistHeaders(env),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Todoist completed tasks API error: ${response.status} - ${errorText}`);
  }

  interface CompletedItemResponse {
    id: string;
    content: string;
    project_id: string;
    completed_at: string;
    description?: string;
  }

  const data = (await response.json()) as { items?: CompletedItemResponse[] };
  const { subProjects } = projectHierarchy;

  const rawItems = data.items ?? [];

  // Client-side time filtering as a safety net
  const sinceTime = sinceDate.getTime();
  const timeFilteredItems = rawItems.filter((item) => {
    const completedTime = new Date(item.completed_at).getTime();
    return completedTime > sinceTime;
  });

  // Filter to only tasks from sub-projects we're tracking
  const completedTasks = timeFilteredItems.filter((item) => {
    const projectId = String(item.project_id);
    return subProjects.has(projectId);
  });

  // Enrich with repo info
  return completedTasks.map((completedItem) => {
    const projectId = String(completedItem.project_id);
    const subProject = subProjects.get(projectId);

    return {
      id: String(completedItem.id),
      content: completedItem.content,
      description: completedItem.description ?? '',
      project_id: completedItem.project_id,
      completed_at: completedItem.completed_at,
      _org: subProject?.org,
      _repoName: subProject?.repoName,
      _fullRepo: subProject?.fullRepo,
      _webBaseUrl: subProject?.webBaseUrl,
    };
  });
}
