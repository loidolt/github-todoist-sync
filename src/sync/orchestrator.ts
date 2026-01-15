import type { Env } from '../types/env.js';
import type { SyncState, SyncResults } from '../types/sync-state.js';
import { Logger } from '../logging/logger.js';
import { loadSyncState, saveSyncState, recordError, clearErrors } from '../state/sync-state.js';
import { parseOrgMappings, fetchTodoistProjects, buildProjectHierarchy } from '../todoist/projects.js';
import { fetchSectionsForProjects } from '../todoist/sections.js';
import { parseGitHubUrl } from '../utils/helpers.js';
import { getGitHubIssue, closeGitHubIssue } from '../github/issues.js';
import { pollGitHubChanges } from './github-polling.js';
import { pollTodoistChanges, pollCompletedTasks } from './todoist-polling.js';
import { syncIssueToTodoist, syncTaskToGitHub } from './reconciliation.js';
import { resolveGitHubUrlForCompletedTask } from './task-mapping.js';
import { performAutoBackfill, type AutoBackfillResults } from './auto-backfill.js';
import type { MilestoneCache } from '../github/milestones.js';

/**
 * Result of a bidirectional sync operation
 */
export interface SyncResult {
  success: boolean;
  duration: number;
  results: SyncResults;
  error?: string;
  warning?: string;
}

/**
 * Perform bidirectional sync between GitHub and Todoist
 * Called by the scheduled handler
 */
export async function performBidirectionalSync(
  env: Env,
  logger: Logger
): Promise<SyncResult> {
  const syncLogger = logger.child({ operation: 'bidirectional-sync' });
  syncLogger.info('Starting bidirectional sync...');
  const startTime = Date.now();

  // Load current sync state
  let state = await loadSyncState(env, syncLogger);
  syncLogger.info(`Last sync: ${state.lastPollTime ?? 'never'}, Poll count: ${state.pollCount}`);

  const results: SyncResults = {
    github: { processed: 0, created: 0, updated: 0, completed: 0, reopened: 0, sectionUpdated: 0, errors: 0 },
    todoist: { processed: 0, closed: 0, reopened: 0, createdIssues: 0, milestoneUpdated: 0, errors: 0 },
    autoBackfill: { newProjects: 0, issues: 0, created: 0, skipped: 0, errors: 0 },
  };

  try {
    // Parse org mappings and build project hierarchy
    const orgMappings = parseOrgMappings(env, syncLogger);
    if (orgMappings.size === 0) {
      syncLogger.warn('No org mappings configured, skipping sync');
      return { success: false, duration: Date.now() - startTime, results, error: 'No ORG_MAPPINGS configured' };
    }

    // Fetch Todoist projects and build hierarchy
    syncLogger.info('Fetching Todoist project hierarchy...');
    const projects = await fetchTodoistProjects(env);
    const projectHierarchy = buildProjectHierarchy(projects, orgMappings, syncLogger);

    if (projectHierarchy.subProjects.size === 0) {
      syncLogger.warn('No sub-projects found under mapped parent projects');
      return { success: true, duration: Date.now() - startTime, results, warning: 'No repos configured' };
    }

    // Pre-fetch sections for milestone mapping
    const currentProjectIds = Array.from(projectHierarchy.subProjects.keys());
    syncLogger.info('Fetching sections for milestone mapping...');
    const { sectionCache, sectionIdToName } = await fetchSectionsForProjects(env, currentProjectIds, syncLogger);

    // Initialize milestone cache (populated lazily per-repo)
    const milestoneCache: MilestoneCache = new Map();

    // Detect new projects for auto-backfill
    const knownProjectIds = new Set(state.knownProjectIds ?? []);
    const hasKnownProjects = state.knownProjectIds !== undefined && state.knownProjectIds.length > 0;
    const newProjectIds = currentProjectIds.filter((id) => !knownProjectIds.has(id));

    // Check for forced backfill
    const forceBackfill = state.forceBackfillNextSync === true;
    const forceBackfillProjectIds = state.forceBackfillProjectIds ?? [];

    let incompleteBackfillProjects: string[] = [];

    if (forceBackfill && forceBackfillProjectIds.length > 0) {
      syncLogger.info(
        `Forced backfill triggered for ${forceBackfillProjectIds.length} project(s)`,
        { projectIds: forceBackfillProjectIds }
      );
      results.autoBackfill.newProjects = forceBackfillProjectIds.length;
      incompleteBackfillProjects = await performAutoBackfill(
        env,
        forceBackfillProjectIds,
        projectHierarchy,
        results.autoBackfill,
        syncLogger,
        sectionCache
      );
    } else if (newProjectIds.length > 0 && hasKnownProjects) {
      syncLogger.info(`Detected ${newProjectIds.length} new project(s) for auto-backfill`, {
        projectIds: newProjectIds,
      });
      results.autoBackfill.newProjects = newProjectIds.length;
      incompleteBackfillProjects = await performAutoBackfill(
        env,
        newProjectIds,
        projectHierarchy,
        results.autoBackfill,
        syncLogger,
        sectionCache
      );
    } else if (!hasKnownProjects && !forceBackfill) {
      if (state.pollCount > 0) {
        syncLogger.info(
          `Recording ${currentProjectIds.length} existing project(s) as baseline (migrating from older sync state)`
        );
      } else {
        syncLogger.info(
          `First sync: recording ${currentProjectIds.length} project(s) as baseline`
        );
      }
    } else if (newProjectIds.length === 0 && !forceBackfill) {
      syncLogger.debug(`No new projects detected (tracking ${knownProjectIds.size} project(s))`);
    }

    // Poll GitHub for changes
    syncLogger.info(`Polling GitHub for issues updated since: ${state.lastGitHubSync ?? 'beginning'}`);
    const githubPollResult = await pollGitHubChanges(env, state.lastGitHubSync, projectHierarchy, syncLogger);
    const githubIssues = githubPollResult.issues;
    syncLogger.info(`Found ${githubIssues.length} GitHub issues to process`, {
      issueCount: githubIssues.length,
      successfulRepos: githubPollResult.successfulRepos,
      failedRepos: githubPollResult.failedRepos,
    });

    // Record any repo polling errors
    if (githubPollResult.repoErrors.length > 0) {
      for (const repoError of githubPollResult.repoErrors) {
        state = recordError(state, `github-polling:${repoError.repo}`, new Error(repoError.error));
      }
    }

    // Process GitHub -> Todoist sync
    for (const issue of githubIssues) {
      try {
        const result = await syncIssueToTodoist(env, issue, sectionCache, syncLogger);
        results.github.processed++;
        if (result.action === 'created') results.github.created++;
        else if (result.action === 'updated') results.github.updated++;
        else if (result.action === 'completed') results.github.completed++;
        else if (result.action === 'reopened') results.github.reopened++;
        else if (result.action === 'section_updated') results.github.sectionUpdated++;
      } catch (error) {
        syncLogger.error(`Error syncing issue ${issue._repoFullName}#${issue.number}`, error);
        results.github.errors++;
        state = recordError(state, 'sync-issue-to-todoist', error);
      }
    }

    // Poll Todoist for changes
    syncLogger.info(
      `Polling Todoist with sync token: ${state.todoistSyncToken === '*' ? 'full sync' : 'incremental'}`
    );
    const { tasks: todoistTasks, newSyncToken, fullSync } = await pollTodoistChanges(
      env,
      state.todoistSyncToken,
      projectHierarchy
    );
    syncLogger.info(`Found ${todoistTasks.length} Todoist tasks to process (full_sync: ${fullSync})`);

    let allProcessingSucceeded = true;

    // Process Todoist -> GitHub sync
    for (const task of todoistTasks) {
      try {
        const result = await syncTaskToGitHub(env, task, sectionIdToName, milestoneCache, syncLogger);
        results.todoist.processed++;
        if (result.action === 'completed') results.todoist.closed++;
        else if (result.action === 'reopened') results.todoist.reopened++;
        else if (result.action === 'created') results.todoist.createdIssues++;
        else if (result.action === 'section_updated') results.todoist.milestoneUpdated++;
      } catch (error) {
        syncLogger.error(`Error syncing task ${task.id}`, error);
        results.todoist.errors++;
        allProcessingSucceeded = false;
        state = recordError(state, 'sync-task-to-github', error);
      }
    }

    // Poll for completed tasks
    syncLogger.info(`Polling Todoist for completed tasks since: ${state.lastCompletedSync ?? 'beginning'}`);
    const completedTasks = await pollCompletedTasks(env, state.lastCompletedSync, projectHierarchy);
    syncLogger.info(`Found ${completedTasks.length} completed tasks to process`);

    // Track the latest successfully processed completed_at timestamp
    // We only advance lastCompletedSync to the latest successful task to avoid skipping failed tasks
    let latestSuccessfulCompletedAt: string | null = null;
    let completedTasksProcessed = 0;
    let completedTasksSkipped = 0;

    // Process completed tasks
    for (const completedTask of completedTasks) {
      try {
        const resolution = await resolveGitHubUrlForCompletedTask(env, completedTask, syncLogger);
        if (!resolution) {
          // Could not resolve GitHub URL - this task will be retried on next sync
          // because we won't advance lastCompletedSync past it
          syncLogger.warn(`Could not resolve GitHub URL for completed task ${completedTask.id}`, {
            taskId: completedTask.id,
            content: completedTask.content,
            hasDescription: !!completedTask.description,
            hasFullRepo: !!completedTask._fullRepo,
          });
          completedTasksSkipped++;
          continue;
        }

        const { url: githubUrl, source } = resolution;
        const githubInfo = parseGitHubUrl(githubUrl);

        if (!githubInfo) {
          syncLogger.warn(`Invalid GitHub URL format: ${githubUrl}`, { taskId: completedTask.id });
          completedTasksSkipped++;
          continue;
        }

        const issue = await getGitHubIssue(env, githubInfo.owner, githubInfo.repo, githubInfo.issueNumber);
        if (!issue) {
          syncLogger.warn(
            `GitHub issue not found: ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`
          );
          // Issue doesn't exist - mark as processed so we don't keep retrying
          if (!latestSuccessfulCompletedAt || completedTask.completed_at > latestSuccessfulCompletedAt) {
            latestSuccessfulCompletedAt = completedTask.completed_at;
          }
          completedTasksProcessed++;
          continue;
        }

        if (issue.state === 'open') {
          syncLogger.info(
            `Closing issue (resolved via ${source}): ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`
          );
          await closeGitHubIssue(env, githubInfo.owner, githubInfo.repo, githubInfo.issueNumber);
          results.todoist.closed++;

          try {
            await env.WEBHOOK_CACHE.delete(`task:${completedTask.id}`);
          } catch {
            // Ignore cleanup errors
          }
        }

        // Task was successfully processed (either closed or already closed)
        if (!latestSuccessfulCompletedAt || completedTask.completed_at > latestSuccessfulCompletedAt) {
          latestSuccessfulCompletedAt = completedTask.completed_at;
        }
        completedTasksProcessed++;
      } catch (error) {
        syncLogger.error(`Error processing completed task ${completedTask.id}`, error);
        results.todoist.errors++;
        allProcessingSucceeded = false;
        state = recordError(state, 'process-completed-task', error);
        // Don't update latestSuccessfulCompletedAt - this task will be retried
      }
    }

    if (completedTasksSkipped > 0) {
      syncLogger.warn(`${completedTasksSkipped} completed task(s) skipped due to URL resolution failure - will retry on next sync`);
    }

    // Save updated sync state
    const hasIncompleteBackfill = incompleteBackfillProjects.length > 0;
    const hasErrors = results.github.errors > 0 || results.todoist.errors > 0;

    // Only advance lastCompletedSync to the latest successfully processed task
    // This ensures failed tasks will be retried on the next sync
    const newLastCompletedSync = latestSuccessfulCompletedAt ?? state.lastCompletedSync ?? null;

    const newState: SyncState = {
      ...state,
      lastGitHubSync: new Date().toISOString(),
      lastCompletedSync: newLastCompletedSync,
      todoistSyncToken: allProcessingSucceeded ? newSyncToken : state.todoistSyncToken,
      lastPollTime: new Date().toISOString(),
      pollCount: state.pollCount + 1,
      knownProjectIds: currentProjectIds,
      forceBackfillNextSync: hasIncompleteBackfill,
      forceBackfillProjectIds: incompleteBackfillProjects,
    };

    // Update error tracking
    const finalState = hasErrors ? newState : clearErrors(newState);

    if (!allProcessingSucceeded) {
      syncLogger.warn('Some tasks failed to process - keeping previous sync token to retry on next sync');
    }

    await saveSyncState(env, finalState, syncLogger);

    if (hasIncompleteBackfill) {
      syncLogger.info(`${incompleteBackfillProjects.length} project(s) will continue backfilling on next sync`);
    }

    const duration = Date.now() - startTime;
    syncLogger.info(`Sync completed in ${duration}ms`, { results });

    return { success: true, duration, results };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    syncLogger.error('Sync failed', error);

    // Record the error
    state = recordError(state, 'bidirectional-sync', error);
    await saveSyncState(env, state, syncLogger);

    return { success: false, duration: Date.now() - startTime, results, error: message };
  }
}
