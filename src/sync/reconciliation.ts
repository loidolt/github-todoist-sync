/**
 * Bidirectional Reconciliation Module
 *
 * This module handles the core sync logic between GitHub issues and Todoist tasks.
 * It implements the reconciliation rules that determine what action to take when
 * the state of an issue or task changes.
 *
 * ## Sync Flow Overview
 *
 * ### GitHub -> Todoist (syncIssueToTodoist)
 * 1. Issue opened -> Create task in corresponding sub-project
 * 2. Issue closed -> Complete the task
 * 3. Issue reopened -> Reopen the task
 * 4. Milestone changed -> Move task to corresponding section
 * 5. Title changed -> Update task content
 *
 * ### Todoist -> GitHub (syncTaskToGitHub)
 * 1. Task created (with GitHub URL) -> Sync completion state back
 * 2. Task completed -> Close the linked GitHub issue
 * 3. Task reopened -> Reopen the linked GitHub issue
 * 4. Task created (no URL) -> Create new GitHub issue
 * 5. Section changed -> Update issue milestone
 *
 * ## Key Concepts
 *
 * - **Section Cache**: Maps section names to IDs per project (for milestone mapping)
 * - **Milestone Cache**: Maps milestone names to numbers per repo
 * - **Section ID to Name Cache**: Reverse mapping for Todoist->GitHub sync
 */

import type { Env } from '../types/env.js';
import type { GitHubIssue, ParsedGitHubUrl } from '../types/github.js';
import type { TodoistSyncTask, SectionCache } from '../types/todoist.js';
import type { SyncAction } from '../types/api.js';
import type { MilestoneCache } from '../github/milestones.js';
import type { SectionIdToNameCache } from '../todoist/sections.js';
import type { Logger } from '../logging/logger.js';
import { isTaskCompleted, stripTodoistPrefix, parseGitHubUrl, formatTaskContent } from '../utils/helpers.js';
import { findTodoistTaskByIssueUrl, createTodoistTask, completeTodoistTask, reopenTodoistTask, updateTodoistTask } from '../todoist/tasks.js';
import { getOrCreateSection, updateTodoistTaskSection } from '../todoist/sections.js';
import { getGitHubIssue, closeGitHubIssue, reopenGitHubIssue, createGitHubIssue } from '../github/issues.js';
import { getMilestoneNumber, updateGitHubIssueMilestone } from '../github/milestones.js';

/**
 * Sync a GitHub issue to Todoist
 *
 * This function implements the GitHub -> Todoist direction of the sync.
 * It handles the following scenarios:
 *
 * 1. **No existing task + open issue**: Creates a new task
 *    - Task is created in the project corresponding to the repo
 *    - If issue has a milestone, task is placed in a section with that name
 *
 * 2. **No existing task + closed issue**: Skips (no action needed)
 *
 * 3. **Task exists + issue closed**: Completes the task
 *
 * 4. **Task exists + issue open but task completed**: Reopens the task
 *
 * 5. **Task exists + milestone changed**: Moves task to new section
 *
 * 6. **Task exists + title changed**: Updates task content
 *
 * @param env - Environment with API tokens
 * @param issue - GitHub issue to sync (enriched with project info)
 * @param sectionCache - Optional cache for section name -> ID mapping
 * @param logger - Optional logger for structured logging
 * @returns Action taken during sync
 */
export async function syncIssueToTodoist(
  env: Env,
  issue: GitHubIssue,
  sectionCache: SectionCache | null = null,
  logger?: Logger
): Promise<SyncAction> {
  const issueUrl = issue.html_url;
  const repoFullName = issue._repoFullName ?? '';
  const projectId = issue._todoistProjectId;
  const issueRef = `${repoFullName}#${issue.number}`;

  // Cannot sync without knowing which project to use
  if (!projectId) {
    return { action: 'skipped', reason: 'no_project_id', issue: issueRef };
  }

  // Determine target section based on milestone
  // Milestones map to sections: milestone "v1.0" -> section "v1.0"
  let targetSectionId: string | null = null;
  const milestoneName = issue.milestone?.title;

  if (milestoneName && sectionCache) {
    try {
      targetSectionId = await getOrCreateSection(env, projectId, milestoneName, sectionCache);
    } catch (error) {
      const msg = `Failed to get/create section for milestone "${milestoneName}"`;
      if (logger) {
        logger.error(msg, error, { milestone: milestoneName, projectId });
      } else {
        console.error(`${msg}:`, error);
      }
      // Continue without section - non-fatal error
    }
  }

  // Find existing task by looking for tasks with this issue URL in description
  const task = await findTodoistTaskByIssueUrl(env, issueUrl);

  if (!task) {
    // No task exists for this issue - create if issue is open
    if (issue.state === 'open') {
      const sectionInfo = targetSectionId ? ` in section "${milestoneName}"` : '';
      const msg = `Creating task for open issue: ${issueRef} in project ${projectId}${sectionInfo}`;
      if (logger) {
        logger.info(msg, { issue: issueRef, projectId, section: milestoneName ?? null });
      } else {
        console.log(msg);
      }
      await createTodoistTask(env, {
        title: issue.title,
        issueNumber: issue.number,
        issueUrl,
        projectId,
        sectionId: targetSectionId,
      });
      return { action: 'created', issue: issueRef, section: milestoneName ?? null };
    }
    // Issue is closed and no task exists - nothing to do
    return { action: 'skipped', reason: 'closed_no_task', issue: issueRef };
  }

  // Task exists - check if we need to sync state
  const taskCompleted = isTaskCompleted(task);

  // Case: Issue closed but task still open -> complete the task
  if (issue.state === 'closed' && !taskCompleted) {
    const msg = `Completing task for closed issue: ${issueRef}`;
    if (logger) {
      logger.info(msg, { issue: issueRef, taskId: task.id });
    } else {
      console.log(msg);
    }
    await completeTodoistTask(env, task.id);
    return { action: 'completed', issue: issueRef };
  }

  // Case: Issue reopened but task still completed -> reopen the task
  if (issue.state === 'open' && taskCompleted) {
    const msg = `Reopening task for reopened issue: ${issueRef}`;
    if (logger) {
      logger.info(msg, { issue: issueRef, taskId: task.id });
    } else {
      console.log(msg);
    }
    await reopenTodoistTask(env, task.id);
    return { action: 'reopened', issue: issueRef };
  }

  // Check for title changes - keep task content in sync with issue title
  const expectedTitle = formatTaskContent(issue.number, issue.title);
  let updated = false;

  if (task.content !== expectedTitle) {
    const msg = `Updating task title for issue: ${issueRef}`;
    if (logger) {
      logger.debug(msg, { issue: issueRef, taskId: task.id, oldTitle: task.content, newTitle: expectedTitle });
    } else {
      console.log(msg);
    }
    await updateTodoistTask(env, task.id, { content: expectedTitle });
    updated = true;
  }

  // Check if section needs updating (milestone changed)
  // This handles the case where an issue's milestone was changed in GitHub
  const currentSectionId = task.section_id ? String(task.section_id) : null;
  const targetSectionIdStr = targetSectionId ? String(targetSectionId) : null;

  if (currentSectionId !== targetSectionIdStr && sectionCache) {
    const sectionInfo = milestoneName ? ` to section "${milestoneName}"` : ' (removing from section)';
    const msg = `Moving task for issue ${issueRef}${sectionInfo}`;
    if (logger) {
      logger.info(msg, { issue: issueRef, taskId: task.id, fromSection: currentSectionId, toSection: targetSectionIdStr });
    } else {
      console.log(msg);
    }
    await updateTodoistTaskSection(env, task.id, targetSectionId);
    return { action: 'section_updated', issue: issueRef, section: milestoneName ?? null };
  }

  if (updated) {
    return { action: 'updated', issue: issueRef };
  }

  return { action: 'unchanged', issue: issueRef };
}

/**
 * Sync a Todoist task to GitHub
 *
 * This function implements the Todoist -> GitHub direction of the sync.
 * It handles two distinct scenarios based on whether the task has a GitHub URL:
 *
 * ## Scenario A: Task has GitHub URL (was created from GitHub issue)
 * The task already has a linked GitHub issue. We sync state changes back:
 *
 * 1. **Task completed + issue open**: Close the issue
 * 2. **Task reopened + issue closed**: Reopen the issue
 * 3. **Section changed**: Update issue milestone to match section name
 *
 * ## Scenario B: Task has no GitHub URL (created in Todoist)
 * This is a new task that needs a GitHub issue created:
 *
 * 1. Skip if task is completed (don't create closed issues)
 * 2. Determine milestone from section (if task is in a section)
 * 3. Create GitHub issue with matching milestone
 * 4. Update task with issue URL and number prefix
 *
 * @param env - Environment with API tokens
 * @param task - Todoist task to sync (enriched with repo info)
 * @param sectionIdToName - Optional reverse mapping of section ID to name
 * @param milestoneCache - Optional cache for milestone name to number
 * @param logger - Optional logger for structured logging
 * @returns Action taken during sync
 */
export async function syncTaskToGitHub(
  env: Env,
  task: TodoistSyncTask,
  sectionIdToName: SectionIdToNameCache | null = null,
  milestoneCache: MilestoneCache | null = null,
  logger?: Logger
): Promise<SyncAction> {
  // First check if task has GitHub URL (was created from GitHub issue)
  // The URL is stored in the task description
  const githubInfo = parseGitHubUrl(task.description);

  if (githubInfo) {
    // Scenario A: Task was created from GitHub issue - sync state back
    const issueRef = `${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`;

    const issue = await getGitHubIssue(env, githubInfo.owner, githubInfo.repo, githubInfo.issueNumber);
    if (!issue) {
      const msg = `GitHub issue not found: ${issueRef}`;
      if (logger) {
        logger.warn(msg, { issue: issueRef, taskId: task.id });
      } else {
        console.warn(msg);
      }
      return { action: 'skipped', reason: 'issue_not_found', taskId: task.id };
    }

    const taskCompleted = isTaskCompleted(task);

    // Case: Task completed in Todoist -> close the GitHub issue
    if (taskCompleted && issue.state === 'open') {
      const msg = `Closing issue for completed task: ${issueRef}`;
      if (logger) {
        logger.info(msg, { issue: issueRef, taskId: task.id });
      } else {
        console.log(msg);
      }
      await closeGitHubIssue(env, githubInfo.owner, githubInfo.repo, githubInfo.issueNumber);
      return { action: 'completed', issue: issueRef };
    }

    // Case: Task reopened in Todoist -> reopen the GitHub issue
    if (!taskCompleted && issue.state === 'closed') {
      const msg = `Reopening issue for uncompleted task: ${issueRef}`;
      if (logger) {
        logger.info(msg, { issue: issueRef, taskId: task.id });
      } else {
        console.log(msg);
      }
      await reopenGitHubIssue(env, githubInfo.owner, githubInfo.repo, githubInfo.issueNumber);
      return { action: 'reopened', issue: issueRef };
    }

    // Check if section changed and needs to sync milestone
    // Section name in Todoist maps to milestone title in GitHub
    if (sectionIdToName && milestoneCache) {
      const projectIdStr = String(task.project_id);
      const taskSectionId = task.section_id ? String(task.section_id) : null;

      // Look up section name from ID
      const projectSectionIdToName = sectionIdToName.get(projectIdStr);
      const taskSectionName =
        taskSectionId && projectSectionIdToName
          ? projectSectionIdToName.get(taskSectionId) ?? null
          : null;

      const currentMilestoneName = issue.milestone?.title ?? null;

      // If section doesn't match current milestone, update the milestone
      if (taskSectionName !== currentMilestoneName) {
        try {
          // Get milestone number (milestones must exist in GitHub - we don't create them)
          const milestoneNumber = taskSectionName
            ? await getMilestoneNumber(env, githubInfo.owner, githubInfo.repo, taskSectionName, milestoneCache)
            : null;

          // Only update if we found a milestone or we're removing it (taskSectionName is null)
          if (milestoneNumber !== null || taskSectionName === null) {
            const msg = `Updating milestone for issue ${issueRef}: "${currentMilestoneName}" → "${taskSectionName}"`;
            if (logger) {
              logger.info(msg, { issue: issueRef, fromMilestone: currentMilestoneName, toMilestone: taskSectionName });
            } else {
              console.log(msg);
            }
            await updateGitHubIssueMilestone(
              env,
              githubInfo.owner,
              githubInfo.repo,
              githubInfo.issueNumber,
              milestoneNumber
            );
            return {
              action: 'section_updated',
              issue: issueRef,
              section: taskSectionName,
            };
          } else if (taskSectionName) {
            // Milestone doesn't exist in GitHub - warn but don't fail
            const msg = `Cannot find milestone "${taskSectionName}" in ${githubInfo.owner}/${githubInfo.repo} - skipping milestone update`;
            if (logger) {
              logger.warn(msg, { milestone: taskSectionName, repo: `${githubInfo.owner}/${githubInfo.repo}` });
            } else {
              console.warn(msg);
            }
          }
        } catch (error) {
          const msg = `Failed to update milestone for issue ${issueRef}`;
          if (logger) {
            logger.error(msg, error, { issue: issueRef });
          } else {
            console.error(`${msg}:`, error);
          }
        }
      }
    }

    return { action: 'unchanged', issue: issueRef };
  }

  // Scenario B: No GitHub URL - task was created in Todoist, might need to create GitHub issue
  // The _githubOrg and _repoName are enriched during polling based on project hierarchy
  if (!task._githubOrg || !task._repoName) {
    return { action: 'skipped', reason: 'no_repo_info', taskId: task.id };
  }

  // Skip completed tasks - don't create closed issues
  // This prevents creating issues for tasks that were already completed
  if (isTaskCompleted(task)) {
    return { action: 'skipped', reason: 'completed_no_issue', taskId: task.id };
  }

  // Determine milestone from section
  // If the task is in a section, we'll try to assign the matching milestone
  let milestoneNumber: number | null = null;
  let milestoneName: string | null = null;

  if (sectionIdToName && milestoneCache && task.section_id) {
    const projectIdStr = String(task.project_id);
    const taskSectionId = String(task.section_id);
    const projectSectionIdToName = sectionIdToName.get(projectIdStr);

    if (projectSectionIdToName) {
      milestoneName = projectSectionIdToName.get(taskSectionId) ?? null;
      if (milestoneName) {
        try {
          milestoneNumber = await getMilestoneNumber(
            env,
            task._githubOrg,
            task._repoName,
            milestoneName,
            milestoneCache
          );
          if (!milestoneNumber) {
            const msg = `Milestone "${milestoneName}" not found in ${task._fullRepo} - creating issue without milestone`;
            if (logger) {
              logger.warn(msg, { milestone: milestoneName, repo: task._fullRepo });
            } else {
              console.warn(msg);
            }
          }
        } catch (error) {
          const msg = `Failed to get milestone for ${task._fullRepo}`;
          if (logger) {
            logger.error(msg, error, { repo: task._fullRepo, milestone: milestoneName });
          } else {
            console.error(`${msg}:`, error);
          }
        }
      }
    }
  }

  // Create GitHub issue for this task
  // Strip any existing [#N] prefix from task content to get clean title
  const issueTitle = stripTodoistPrefix(task.content);
  const milestoneInfo = milestoneNumber ? ` with milestone "${milestoneName}"` : '';
  const msg = `Creating GitHub issue for task: ${task._fullRepo} - ${issueTitle}${milestoneInfo}`;
  if (logger) {
    logger.info(msg, { repo: task._fullRepo, taskId: task.id, milestone: milestoneName });
  } else {
    console.log(msg);
  }

  try {
    const issue = await createGitHubIssue(
      env,
      task._githubOrg,
      task._repoName,
      issueTitle,
      task.description || `Created from Todoist task: ${task.id}`,
      milestoneNumber
    );

    // Update task with GitHub URL (for future sync) and add issue number prefix
    // This prevents the task from being synced again as a "new" task
    const newTaskContent = formatTaskContent(issue.number, issueTitle);
    await updateTodoistTask(env, task.id, {
      content: newTaskContent,
      description: issue.html_url,
    });

    const successMsg = `Created GitHub issue: ${issue.html_url}`;
    if (logger) {
      logger.info(successMsg, { issueUrl: issue.html_url, taskId: task.id });
    } else {
      console.log(successMsg);
    }

    return { action: 'created', issue: issue.html_url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errMsg = `Failed to create GitHub issue for task ${task.id}`;
    if (logger) {
      logger.error(errMsg, error, { taskId: task.id, repo: task._fullRepo });
    } else {
      console.error(`${errMsg}:`, error);
    }
    return { action: 'error', error: message, taskId: task.id };
  }
}
