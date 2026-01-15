import type { Env } from '../types/env.js';
import type { GitHubIssue } from '../types/github.js';
import type { SectionCache } from '../types/todoist.js';
import { CONSTANTS } from '../config/constants.js';
import { verifyBackfillAuth, validateBackfillRequest, type BackfillParams } from '../utils/auth.js';
import { jsonResponse } from '../utils/helpers.js';
import { createLogger, LogLevel, type Logger } from '../logging/logger.js';
import { parseOrgMappings, fetchTodoistProjects, buildProjectHierarchy } from '../todoist/projects.js';
import { fetchExistingTasksForProjects, taskExistsForIssue, createTodoistTask } from '../todoist/tasks.js';
import { fetchSectionsForProjects, getOrCreateSection } from '../todoist/sections.js';
import { fetchGitHubIssues } from '../github/issues.js';
import { fetchOrgRepos } from '../github/repos.js';
import { RateLimiter } from '../todoist/client.js';

/**
 * Process a single issue for backfill
 */
async function processBackfillIssue(
  env: Env,
  issue: GitHubIssue,
  repoFullName: string,
  dryRun: boolean,
  projectId: string | null,
  existingTasks: Map<string, { taskId: string; projectId: string }> | null,
  sectionCache: SectionCache | null,
  logger: Logger
): Promise<{
  status: 'created' | 'would_create' | 'skipped' | 'failed';
  reason?: string;
  error?: string;
  taskId?: string;
  milestone?: string | null;
  section?: string | null;
}> {
  try {
    // Check existence
    const exists = existingTasks
      ? existingTasks.has(issue.html_url)
      : await taskExistsForIssue(env, issue.html_url, logger);

    if (exists) {
      return { status: 'skipped', reason: 'already_exists' };
    }

    if (dryRun) {
      const milestone = issue.milestone?.title ?? null;
      return { status: 'would_create', milestone };
    }

    if (!projectId) {
      return { status: 'failed', error: 'projectId required - use "projects" mode for task creation' };
    }

    // Determine section from milestone
    let sectionId: string | null = null;
    const milestoneName = issue.milestone?.title;
    if (milestoneName && sectionCache) {
      try {
        sectionId = await getOrCreateSection(env, projectId, milestoneName, sectionCache, logger);
      } catch (error) {
        logger.error(`Failed to get/create section for milestone "${milestoneName}"`, error);
      }
    }

    const task = await createTodoistTask(env, {
      title: issue.title,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      projectId,
      sectionId,
    }, logger);

    return { status: 'created', taskId: task.id, section: milestoneName ?? null };
  } catch (error) {
    logger.error(`Failed to process issue ${repoFullName}#${issue.number}`, error);
    return { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Handle POST /backfill request
 * Supports streaming NDJSON response for real-time progress
 */
export async function handleBackfill(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const logger = createLogger(LogLevel.INFO);

  // Authenticate
  if (!verifyBackfillAuth(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Parse and validate request
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const validation = validateBackfillRequest(body, env);
  if (!validation.valid) {
    return jsonResponse({ error: validation.error }, 400);
  }

  const { mode, repo, owner, state, dryRun, limit } = validation.params;

  // Create streaming response
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const writeJSON = async (data: unknown): Promise<void> => {
    await writer.write(encoder.encode(JSON.stringify(data) + '\n'));
  };

  // Process and stream results
  const processBackfill = async (): Promise<void> => {
    const summary = { total: 0, created: 0, skipped: 0, failed: 0 };
    const githubLimiter = new RateLimiter(CONSTANTS.GITHUB_RATE_LIMIT);
    const todoistLimiter = new RateLimiter(CONSTANTS.TODOIST_RATE_LIMIT);

    try {
      let repos: Array<{ owner: string; name: string; projectId: string | null }>;
      let existingTasks: Map<string, { taskId: string; projectId: string }> | null = null;
      let sectionCache: SectionCache | null = null;

      if (mode === 'create-mappings') {
        // Special mode: Create KV mappings for existing tasks
        const orgMappings = parseOrgMappings(env, logger);
        const projects = await fetchTodoistProjects(env);
        const hierarchy = buildProjectHierarchy(projects, orgMappings, logger);

        const projectIds = Array.from(hierarchy.subProjects.values()).map((p) => p.id);
        existingTasks = await fetchExistingTasksForProjects(env, projectIds, logger);

        await writeJSON({
          type: 'config',
          mode: 'create-mappings',
          orgs: Array.from(orgMappings.values()),
          existingTaskCount: existingTasks.size,
        });

        await writeJSON({ type: 'start', totalTasks: existingTasks.size, dryRun });

        let mappingsCreated = 0;
        let mappingsSkipped = 0;

        for (const [issueUrl, taskInfo] of existingTasks) {
          if (dryRun) {
            await writeJSON({
              type: 'mapping',
              taskId: taskInfo.taskId,
              issueUrl,
              status: 'would_create',
            });
            mappingsCreated++;
          } else {
            try {
              await env.WEBHOOK_CACHE.put(`task:${taskInfo.taskId}`, issueUrl, {
                expirationTtl: 60 * 60 * 24 * 365,
              });
              await writeJSON({
                type: 'mapping',
                taskId: taskInfo.taskId,
                issueUrl,
                status: 'created',
              });
              mappingsCreated++;
            } catch (error) {
              await writeJSON({
                type: 'mapping',
                taskId: taskInfo.taskId,
                issueUrl,
                status: 'failed',
                error: error instanceof Error ? error.message : 'Unknown error',
              });
              mappingsSkipped++;
            }
          }
        }

        await writeJSON({
          type: 'complete',
          summary: { total: existingTasks.size, created: mappingsCreated, skipped: mappingsSkipped },
        });

        return;
      } else if (mode === 'single-repo') {
        repos = [{ owner: owner!, name: repo!, projectId: null }];
      } else if (mode === 'projects') {
        const orgMappings = parseOrgMappings(env, logger);
        const projects = await fetchTodoistProjects(env);
        const hierarchy = buildProjectHierarchy(projects, orgMappings, logger);

        repos = Array.from(hierarchy.subProjects.values()).map((p) => ({
          owner: p.githubOrg,
          name: p.repoName,
          projectId: p.id,
        }));

        const projectIds = repos.map((r) => r.projectId!);
        existingTasks = await fetchExistingTasksForProjects(env, projectIds, logger);

        const sectionResult = await fetchSectionsForProjects(env, projectIds, logger);
        sectionCache = sectionResult.sectionCache;

        await writeJSON({
          type: 'config',
          mode: 'projects',
          orgs: Array.from(orgMappings.values()),
          repos: repos.map((r) => `${r.owner}/${r.name}`),
          existingTaskCount: existingTasks.size,
          sectionCount: Array.from(sectionCache.values()).reduce((sum, m) => sum + m.size, 0),
        });
      } else {
        // mode === 'org'
        repos = [];
        for await (const r of fetchOrgRepos(env, owner!)) {
          repos.push({ owner: r.owner.login, name: r.name, projectId: null });
        }
      }

      await writeJSON({ type: 'start', totalRepos: repos.length, dryRun });

      for (const repoInfo of repos) {
        const repoFullName = `${repoInfo.owner}/${repoInfo.name}`;
        let repoIssueCount = 0;

        try {
          await githubLimiter.waitForToken();

          for await (const issue of fetchGitHubIssues(env, repoInfo.owner, repoInfo.name, {
            state,
            limit,
          })) {
            repoIssueCount++;

            if (!dryRun && !existingTasks) {
              await todoistLimiter.waitForToken();
            }

            const result = await processBackfillIssue(
              env,
              issue,
              repoFullName,
              dryRun,
              repoInfo.projectId,
              existingTasks,
              sectionCache,
              logger
            );

            summary.total++;
            if (result.status === 'created' || result.status === 'would_create') {
              summary.created++;
            } else if (result.status === 'skipped') {
              summary.skipped++;
            } else {
              summary.failed++;
            }

            await writeJSON({
              type: 'issue',
              repo: repoFullName,
              issue: issue.number,
              title: issue.title,
              projectId: repoInfo.projectId,
              ...result,
            });
          }

          await writeJSON({
            type: 'repo_complete',
            repo: repoFullName,
            issues: repoIssueCount,
            projectId: repoInfo.projectId,
          });
        } catch (error) {
          logger.error(`Failed to process repo ${repoFullName}`, error);
          await writeJSON({
            type: 'repo_error',
            repo: repoFullName,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      await writeJSON({ type: 'complete', summary });
    } catch (error) {
      logger.error('Backfill failed', error);
      await writeJSON({
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        summary,
      });
    } finally {
      await writer.close();
    }
  };

  // Start processing (don't await - let it stream)
  processBackfill();

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
    },
  });
}
