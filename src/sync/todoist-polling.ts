import type { Env } from '../types/env.js';
import type { TodoistSyncTask, ProjectHierarchy } from '../types/todoist.js';
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
  const response = await fetch(`${CONSTANTS.TODOIST_API_BASE}/sync/v9/sync`, {
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
      task._githubOrg = subProject.githubOrg;
      task._repoName = subProject.repoName;
      task._fullRepo = subProject.fullRepo;
    }
  }

  return {
    tasks: projectTasks,
    newSyncToken: data.sync_token,
    fullSync: data.full_sync ?? false,
  };
}

/**
 * Completed task from the completed/get_all endpoint
 */
export interface CompletedTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  completed_at: string;
  _githubOrg?: string;
  _repoName?: string;
  _fullRepo?: string;
}

/**
 * Poll Todoist for completed tasks
 * Needed because the Sync API does not return completed items
 */
export async function pollCompletedTasks(
  env: Env,
  since: string | null,
  projectHierarchy: ProjectHierarchy
): Promise<CompletedTask[]> {
  const params = new URLSearchParams({
    annotate_items: 'true',
    limit: '200',
  });

  if (since) {
    const sinceDate = new Date(since);
    const formattedSince = sinceDate.toISOString().replace('Z', '').split('.')[0];
    params.set('since', formattedSince ?? '');
  }

  const response = await fetch(
    `${CONSTANTS.TODOIST_API_BASE}/sync/v9/completed/get_all?${params}`,
    {
      headers: getTodoistHeaders(env),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Todoist completed/get_all API error: ${response.status} - ${errorText}`);
  }

  interface CompletedItemResponse {
    task_id: string;
    content: string;
    project_id: string;
    completed_at: string;
    item_object?: { description?: string };
    item?: { description?: string };
  }

  const data = (await response.json()) as { items?: CompletedItemResponse[] };
  const { subProjects } = projectHierarchy;

  // Filter to only tasks from sub-projects we're tracking
  const completedTasks = (data.items ?? []).filter((item) => {
    const projectId = String(item.project_id);
    return subProjects.has(projectId);
  });

  // Enrich with repo info
  return completedTasks.map((completedItem) => {
    const projectId = String(completedItem.project_id);
    const subProject = subProjects.get(projectId);

    return {
      id: completedItem.task_id,
      content: completedItem.content,
      description:
        completedItem.item_object?.description ?? completedItem.item?.description ?? '',
      project_id: completedItem.project_id,
      completed_at: completedItem.completed_at,
      _githubOrg: subProject?.githubOrg,
      _repoName: subProject?.repoName,
      _fullRepo: subProject?.fullRepo,
    };
  });
}
