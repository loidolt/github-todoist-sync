/**
 * Bidirectional Reconciliation Module
 *
 * This module handles the core sync logic between issue providers and Todoist tasks.
 * It implements the reconciliation rules that determine what action to take when
 * the state of an issue or task changes.
 *
 * ## Sync Flow Overview
 *
 * ### Issue Provider -> Todoist (syncIssueToTodoist)
 * 1. Issue opened -> Create task in corresponding sub-project
 * 2. Issue closed -> Complete the task
 * 3. Issue reopened -> Reopen the task
 * 4. Milestone changed -> Move task to corresponding section
 * 5. Title changed -> Update task content
 *
 * ### Todoist -> Issue Provider (syncTaskToGitHub)
 * 1. Task created (with issue URL) -> Sync completion state back
 * 2. Task completed -> Close the linked issue
 * 3. Task reopened -> Reopen the linked issue
 * 4. Task created (no URL) -> Create new issue
 * 5. Section changed -> Update issue milestone
 */

import type { Env } from '../types/env.js';
import type { GitHubIssue } from '../types/github.js';
import type { TodoistSyncTask, SectionCache, ProjectHierarchy } from '../types/todoist.js';
import type { SyncAction } from '../types/api.js';
import type { MilestoneCache, MilestoneCaches } from '../github/milestones.js';
import type { SectionIdToNameCache } from '../todoist/sections.js';
import type { Logger } from '../logging/logger.js';
import type { ProviderRegistry, IssueProvider } from '../providers/types.js';
import { isTaskCompleted, stripTodoistPrefix, formatTaskContent } from '../utils/helpers.js';
import { parseIssueUrlFromAnyProvider } from '../providers/url-parsing.js';
import { findTodoistTaskByIssueUrl, createTodoistTask, completeTodoistTask, reopenTodoistTask, updateTodoistTask } from '../todoist/tasks.js';
import { getOrCreateSection, updateTodoistTaskSection } from '../todoist/sections.js';

/**
 * Sync an issue to Todoist
 *
 * This function implements the Issue Provider -> Todoist direction of the sync.
 * It is platform-agnostic; it only needs the issue data (which is already fetched).
 */
export async function syncIssueToTodoist(
  env: Env,
  issue: GitHubIssue,
  sectionCache: SectionCache,
  logger: Logger
): Promise<SyncAction> {
  const issueUrl = issue.html_url;
  const repoFullName = issue._repoFullName ?? '';
  const projectId = issue._todoistProjectId;
  const issueRef = `${repoFullName}#${issue.number}`;
  const issueLogger = logger.child({ issue: issueRef, projectId });

  if (!projectId) {
    return { action: 'skipped', reason: 'no_project_id', issue: issueRef };
  }

  // Determine target section based on milestone
  let targetSectionId: string | null = null;
  const milestoneName = issue.milestone?.title;

  if (milestoneName) {
    try {
      targetSectionId = await getOrCreateSection(env, projectId, milestoneName, sectionCache);
    } catch (error) {
      issueLogger.error(`Failed to get/create section for milestone "${milestoneName}"`, error, { milestone: milestoneName });
    }
  }

  const task = await findTodoistTaskByIssueUrl(env, issueUrl);

  if (!task) {
    if (issue.state === 'open') {
      const sectionInfo = targetSectionId ? ` in section "${milestoneName}"` : '';
      issueLogger.info(`Creating task for open issue${sectionInfo}`, { section: milestoneName ?? null });
      await createTodoistTask(env, {
        title: issue.title,
        issueNumber: issue.number,
        issueUrl,
        projectId,
        sectionId: targetSectionId,
      });
      return { action: 'created', issue: issueRef, section: milestoneName ?? null };
    }
    return { action: 'skipped', reason: 'closed_no_task', issue: issueRef };
  }

  const taskCompleted = isTaskCompleted(task);

  if (issue.state === 'closed' && !taskCompleted) {
    issueLogger.info('Completing task for closed issue', { taskId: task.id });
    await completeTodoistTask(env, task.id);
    return { action: 'completed', issue: issueRef };
  }

  if (issue.state === 'open' && taskCompleted) {
    issueLogger.info('Reopening task for reopened issue', { taskId: task.id });
    await reopenTodoistTask(env, task.id);
    return { action: 'reopened', issue: issueRef };
  }

  const expectedTitle = formatTaskContent(issue.number, issue.title);
  let updated = false;

  if (task.content !== expectedTitle) {
    issueLogger.debug('Updating task title', { taskId: task.id, oldTitle: task.content, newTitle: expectedTitle });
    await updateTodoistTask(env, task.id, { content: expectedTitle });
    updated = true;
  }

  const currentSectionId = task.section_id ? String(task.section_id) : null;
  const targetSectionIdStr = targetSectionId ? String(targetSectionId) : null;

  if (currentSectionId !== targetSectionIdStr) {
    const sectionInfo = milestoneName ? ` to section "${milestoneName}"` : ' (removing from section)';
    issueLogger.info(`Moving task${sectionInfo}`, { taskId: task.id, fromSection: currentSectionId, toSection: targetSectionIdStr });
    await updateTodoistTaskSection(env, task.id, targetSectionId);
    return { action: 'section_updated', issue: issueRef, section: milestoneName ?? null };
  }

  if (updated) {
    return { action: 'updated', issue: issueRef };
  }

  return { action: 'unchanged', issue: issueRef };
}

/**
 * Get milestone caches for a repo, using the provider's fetchMilestones
 */
async function getProviderMilestoneCaches(
  provider: IssueProvider,
  owner: string,
  repo: string,
  milestoneCache: MilestoneCache
): Promise<MilestoneCaches> {
  const repoKey = `${owner}/${repo}`;
  if (milestoneCache.has(repoKey)) {
    return milestoneCache.get(repoKey)!;
  }

  const milestones = await provider.fetchMilestones(owner, repo);
  const titleToNumber = new Map<string, number>();
  const numberToTitle = new Map<number, string>();

  for (const milestone of milestones) {
    titleToNumber.set(milestone.title, milestone.number);
    numberToTitle.set(milestone.number, milestone.title);
  }

  const caches: MilestoneCaches = { titleToNumber, numberToTitle };
  milestoneCache.set(repoKey, caches);
  return caches;
}

/**
 * Sync a Todoist task to an issue provider (GitHub/Gitea)
 *
 * Uses the provider registry to select the correct platform for API calls.
 */
export async function syncTaskToGitHub(
  env: Env,
  task: TodoistSyncTask,
  sectionIdToName: SectionIdToNameCache,
  milestoneCache: MilestoneCache,
  providerRegistry: ProviderRegistry,
  projectHierarchy: ProjectHierarchy,
  logger: Logger
): Promise<SyncAction> {
  const taskLogger = logger.child({ taskId: task.id });

  // Look up the provider for this task's project
  const projectIdStr = String(task.project_id);
  const subProject = projectHierarchy.subProjects.get(projectIdStr);
  const provider = subProject ? providerRegistry.get(subProject.parentId) : null;

  // Collect all unique providers for multi-provider URL parsing
  const allProviders = new Set(providerRegistry.values());

  // First check if task has an issue URL (was created from an issue)
  const issueInfo = parseIssueUrlFromAnyProvider(task.description, allProviders);

  if (issueInfo) {
    const { provider: urlProvider } = issueInfo;
    const issueRef = `${issueInfo.owner}/${issueInfo.repo}#${issueInfo.issueNumber}`;
    const issueLogger = taskLogger.child({ issue: issueRef });

    const issue = await urlProvider.getIssue(issueInfo.owner, issueInfo.repo, issueInfo.issueNumber);
    if (!issue) {
      issueLogger.warn('Issue not found');
      return { action: 'skipped', reason: 'issue_not_found', taskId: task.id };
    }

    const taskCompleted = isTaskCompleted(task);

    if (taskCompleted && issue.state === 'open') {
      issueLogger.info('Closing issue for completed task');
      await urlProvider.closeIssue(issueInfo.owner, issueInfo.repo, issueInfo.issueNumber);
      return { action: 'completed', issue: issueRef };
    }

    if (!taskCompleted && issue.state === 'closed') {
      issueLogger.info('Reopening issue for uncompleted task');
      await urlProvider.reopenIssue(issueInfo.owner, issueInfo.repo, issueInfo.issueNumber);
      return { action: 'reopened', issue: issueRef };
    }

    // Check if section changed and needs to sync milestone
    const taskSectionId = task.section_id ? String(task.section_id) : null;

    const projectSectionIdToName = sectionIdToName.get(projectIdStr);
    const taskSectionName =
      taskSectionId && projectSectionIdToName
        ? projectSectionIdToName.get(taskSectionId) ?? null
        : null;

    const currentMilestoneName = issue.milestone?.title ?? null;

    if (taskSectionName !== currentMilestoneName) {
      try {
        const milestoneCaches = await getProviderMilestoneCaches(
          urlProvider,
          issueInfo.owner,
          issueInfo.repo,
          milestoneCache
        );
        const milestoneNumber = taskSectionName
          ? milestoneCaches.titleToNumber.get(taskSectionName) ?? null
          : null;

        if (milestoneNumber !== null || taskSectionName === null) {
          issueLogger.info(`Updating milestone: "${currentMilestoneName}" → "${taskSectionName}"`, {
            fromMilestone: currentMilestoneName,
            toMilestone: taskSectionName,
          });
          await urlProvider.updateIssueMilestone(
            issueInfo.owner,
            issueInfo.repo,
            issueInfo.issueNumber,
            milestoneNumber
          );
          return {
            action: 'section_updated',
            issue: issueRef,
            section: taskSectionName,
          };
        } else if (taskSectionName) {
          issueLogger.warn(`Cannot find milestone "${taskSectionName}" - skipping milestone update`, {
            milestone: taskSectionName,
            repo: `${issueInfo.owner}/${issueInfo.repo}`,
          });
        }
      } catch (error) {
        issueLogger.error('Failed to update milestone', error);
      }
    }

    return { action: 'unchanged', issue: issueRef };
  }

  // Scenario B: No issue URL - task was created in Todoist, might need to create an issue
  if (!task._org || !task._repoName) {
    return { action: 'skipped', reason: 'no_repo_info', taskId: task.id };
  }

  if (!provider) {
    return { action: 'skipped', reason: 'no_provider', taskId: task.id };
  }

  const repoLogger = taskLogger.child({ repo: task._fullRepo });

  if (isTaskCompleted(task)) {
    return { action: 'skipped', reason: 'completed_no_issue', taskId: task.id };
  }

  // Determine milestone from section
  let milestoneNumber: number | null = null;
  let milestoneName: string | null = null;

  if (task.section_id) {
    const taskSectionId = String(task.section_id);
    const projectSectionIdToName = sectionIdToName.get(projectIdStr);

    if (projectSectionIdToName) {
      milestoneName = projectSectionIdToName.get(taskSectionId) ?? null;
      if (milestoneName) {
        try {
          const milestoneCaches = await getProviderMilestoneCaches(
            provider,
            task._org,
            task._repoName,
            milestoneCache
          );
          milestoneNumber = milestoneCaches.titleToNumber.get(milestoneName) ?? null;
          if (!milestoneNumber) {
            repoLogger.warn(`Milestone "${milestoneName}" not found - creating issue without milestone`, {
              milestone: milestoneName,
            });
          }
        } catch (error) {
          repoLogger.error('Failed to get milestone', error, { milestone: milestoneName });
        }
      }
    }
  }

  // Create issue for this task
  const issueTitle = stripTodoistPrefix(task.content);
  const milestoneInfo = milestoneNumber ? ` with milestone "${milestoneName}"` : '';
  repoLogger.info(`Creating issue: ${issueTitle}${milestoneInfo}`, { milestone: milestoneName });

  try {
    const issue = await provider.createIssue(
      task._org,
      task._repoName,
      issueTitle,
      task.description || `Created from Todoist task: ${task.id}`,
      milestoneNumber
    );

    const newTaskContent = formatTaskContent(issue.number, issueTitle);
    await updateTodoistTask(env, task.id, {
      content: newTaskContent,
      description: issue.html_url,
    });

    repoLogger.info(`Created issue: ${issue.html_url}`, { issueUrl: issue.html_url });

    return { action: 'created', issue: issue.html_url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    repoLogger.error('Failed to create issue', error);
    return { action: 'error', error: message, taskId: task.id };
  }
}
