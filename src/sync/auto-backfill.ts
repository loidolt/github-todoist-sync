import type { Env } from '../types/env.js';
import type { ProjectHierarchy, SectionCache } from '../types/todoist.js';
import type { Logger } from '../logging/logger.js';
import { CONSTANTS } from '../config/constants.js';
import { fetchGitHubIssues } from '../github/issues.js';
import { fetchExistingTasksForProjects } from '../todoist/tasks.js';
import { batchCreateTodoistTasks, batchCreateSections, type BatchTaskData } from '../todoist/batch.js';

/**
 * Auto-backfill results structure
 */
export interface AutoBackfillResults {
  newProjects: number;
  issues: number;
  created: number;
  skipped: number;
  errors: number;
  /** Per-repo errors for visibility */
  repoErrors?: Array<{ repo: string; error: string }>;
}

/**
 * Task to create during backfill
 */
interface BackfillTask extends BatchTaskData {
  milestoneName?: string;
  fullRepo: string;
}

/**
 * Auto-backfill newly detected projects
 * Called during scheduled sync when new Todoist sub-projects are found
 *
 * Uses batched API calls to minimize subrequest count:
 * 1. Fetch all issues first (GitHub API calls are unavoidable per-repo)
 * 2. Batch create all needed sections in one Sync API call
 * 3. Batch create all tasks in one Sync API call
 *
 * @param env - Environment with API tokens
 * @param newProjectIds - Todoist project IDs to backfill
 * @param projectHierarchy - Project hierarchy with org/repo mappings
 * @param results - Results object to update with backfill progress
 * @param logger - Logger instance for structured logging
 * @param sectionCache - Optional section cache for milestone mapping
 * @returns List of project IDs that still need more backfilling (hit the limit)
 */
export async function performAutoBackfill(
  env: Env,
  newProjectIds: string[],
  projectHierarchy: ProjectHierarchy,
  results: AutoBackfillResults,
  logger: Logger,
  sectionCache: SectionCache | null = null
): Promise<string[]> {
  const backfillLogger = logger.child({ operation: 'auto-backfill' });
  const { subProjects } = projectHierarchy;
  results.repoErrors = [];

  // Get repos to backfill
  const reposToBackfill = newProjectIds
    .filter((id) => subProjects.has(id))
    .map((id) => {
      const project = subProjects.get(id)!;
      return {
        owner: project.githubOrg,
        name: project.repoName,
        projectId: project.id,
        fullRepo: project.fullRepo,
      };
    });

  if (reposToBackfill.length === 0) {
    backfillLogger.info('No new repos to backfill');
    return [];
  }

  backfillLogger.info(`Auto-backfilling ${reposToBackfill.length} new repo(s)`, {
    repoCount: reposToBackfill.length,
    repos: reposToBackfill.map((r) => r.fullRepo),
  });

  // Pre-fetch existing tasks for the new projects (batch operation)
  const existingTasks = await fetchExistingTasksForProjects(
    env,
    reposToBackfill.map((r) => r.projectId)
  );

  backfillLogger.info(
    `Found ${existingTasks.size} existing tasks with GitHub URLs across ${reposToBackfill.length} projects`,
    { existingTaskCount: existingTasks.size, projectCount: reposToBackfill.length }
  );

  // Phase 1: Collect all issues to backfill (respecting per-sync limit)
  const tasksToCreate: BackfillTask[] = [];
  const sectionsNeeded = new Map<string, { projectId: string; name: string }>();
  const incompleteProjects = new Set<string>();
  let hitLimit = false;

  for (const repo of reposToBackfill) {
    const repoLogger = backfillLogger.child({ repo: repo.fullRepo });
    try {
      repoLogger.debug(`Scanning issues for: ${repo.fullRepo}`);
      let repoHasMoreIssues = false;

      for await (const issue of fetchGitHubIssues(env, repo.owner, repo.name, { state: 'open' })) {
        results.issues++;

        // Check if task already exists
        if (existingTasks.has(issue.html_url)) {
          results.skipped++;
          continue;
        }

        // Check per-sync limit
        if (tasksToCreate.length >= CONSTANTS.MAX_TASKS_PER_SYNC) {
          backfillLogger.info(
            `Reached per-sync limit of ${CONSTANTS.MAX_TASKS_PER_SYNC} tasks, will continue on next sync`,
            { limit: CONSTANTS.MAX_TASKS_PER_SYNC, tasksCollected: tasksToCreate.length }
          );
          hitLimit = true;
          repoHasMoreIssues = true;
          break;
        }

        // Determine section from milestone
        let sectionId: string | null = null;
        const milestoneName = issue.milestone?.title;

        if (milestoneName && sectionCache) {
          const projectSections = sectionCache.get(String(repo.projectId));
          if (projectSections?.has(milestoneName)) {
            sectionId = projectSections.get(milestoneName) ?? null;
          } else {
            const sectionKey = `${repo.projectId}:${milestoneName}`;
            if (!sectionsNeeded.has(sectionKey)) {
              sectionsNeeded.set(sectionKey, {
                projectId: repo.projectId,
                name: milestoneName,
              });
            }
          }
        }

        tasksToCreate.push({
          title: issue.title,
          issueNumber: issue.number,
          issueUrl: issue.html_url,
          projectId: repo.projectId,
          milestoneName,
          sectionId,
          fullRepo: repo.fullRepo,
        });
      }

      if (repoHasMoreIssues) {
        incompleteProjects.add(repo.projectId);
      }

      if (hitLimit) {
        const currentIdx = reposToBackfill.findIndex((r) => r.projectId === repo.projectId);
        for (let i = currentIdx + 1; i < reposToBackfill.length; i++) {
          const nextRepo = reposToBackfill[i];
          if (nextRepo) {
            incompleteProjects.add(nextRepo.projectId);
          }
        }
        break;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      repoLogger.error(`Failed to fetch issues for repo ${repo.fullRepo}`, error);
      results.errors++;
      results.repoErrors?.push({ repo: repo.fullRepo, error: errorMessage });
      incompleteProjects.add(repo.projectId);
    }
  }

  if (tasksToCreate.length === 0) {
    backfillLogger.info('No new tasks to create');
    return Array.from(incompleteProjects);
  }

  backfillLogger.info(
    `Collected ${tasksToCreate.length} task(s) to create, ${sectionsNeeded.size} section(s) to create`,
    { taskCount: tasksToCreate.length, sectionCount: sectionsNeeded.size }
  );

  // Phase 2: Batch create needed sections
  if (sectionsNeeded.size > 0 && sectionCache) {
    const sectionsToCreate = Array.from(sectionsNeeded.values()).slice(
      0,
      CONSTANTS.MAX_SECTIONS_PER_SYNC
    );

    if (sectionsToCreate.length > 0) {
      backfillLogger.info(`Batch creating ${sectionsToCreate.length} section(s)`, {
        sectionCount: sectionsToCreate.length,
      });
      const createdSections = await batchCreateSections(env, sectionsToCreate);

      // Update section cache
      for (const [key, sectionId] of createdSections.entries()) {
        const parts = key.split(':');
        const projectId = parts[0];
        const sectionName = parts.slice(1).join(':');

        if (projectId && sectionName) {
          if (!sectionCache.has(projectId)) {
            sectionCache.set(projectId, new Map());
          }
          sectionCache.get(projectId)!.set(sectionName, sectionId);
        }
      }

      // Update tasks with section IDs
      for (const task of tasksToCreate) {
        if (task.milestoneName && !task.sectionId) {
          const sectionKey = `${task.projectId}:${task.milestoneName}`;
          const newSectionId = createdSections.get(sectionKey);
          if (newSectionId) {
            task.sectionId = newSectionId;
          } else {
            const projectSections = sectionCache.get(String(task.projectId));
            if (projectSections?.has(task.milestoneName)) {
              task.sectionId = projectSections.get(task.milestoneName) ?? null;
            }
          }
        }
      }
    }
  }

  // Phase 3: Batch create all tasks
  backfillLogger.info(`Batch creating ${tasksToCreate.length} task(s)`, {
    taskCount: tasksToCreate.length,
  });
  const batchResults = await batchCreateTodoistTasks(env, tasksToCreate);

  results.created = batchResults.success;
  results.errors += batchResults.failed;

  for (const task of tasksToCreate.slice(0, batchResults.success)) {
    const sectionInfo = task.milestoneName ? ` (section: ${task.milestoneName})` : '';
    backfillLogger.debug(`Created task for: ${task.fullRepo}#${task.issueNumber}${sectionInfo}`, {
      repo: task.fullRepo,
      issueNumber: task.issueNumber,
      section: task.milestoneName ?? null,
    });
  }

  if (batchResults.errors.length > 0) {
    backfillLogger.warn(`Batch creation had ${batchResults.errors.length} error(s)`, {
      errorCount: batchResults.errors.length,
      errors: batchResults.errors,
    });
  }

  const incompleteList = Array.from(incompleteProjects);
  if (incompleteList.length > 0) {
    backfillLogger.info(
      `Auto-backfill incomplete, ${incompleteList.length} project(s) need more backfilling on next sync`,
      { incompleteCount: incompleteList.length, projectIds: incompleteList }
    );
  }

  backfillLogger.info('Auto-backfill completed', {
    newProjects: results.newProjects,
    issues: results.issues,
    created: results.created,
    skipped: results.skipped,
    errors: results.errors,
  });
  return incompleteList;
}
