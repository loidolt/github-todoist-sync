import type { Env } from '../types/env.js';
import type { SyncState } from '../types/sync-state.js';
import { verifyBackfillAuth } from '../utils/auth.js';
import { jsonResponse } from '../utils/helpers.js';
import { loadSyncState, saveSyncState } from '../state/sync-state.js';
import { parseOrgMappings, fetchTodoistProjects, buildProjectHierarchy } from '../todoist/projects.js';

/**
 * Handle POST /reset-projects request
 * Resets known projects to trigger auto-backfill on next sync
 */
export async function handleResetProjects(request: Request, env: Env): Promise<Response> {
  // Authenticate
  if (!verifyBackfillAuth(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Parse request body (optional)
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) {
      body = JSON.parse(text) as Record<string, unknown>;
    }
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const mode = (body.mode as string) ?? 'all';
  const projectIds = (body.projectIds as string[]) ?? [];
  const dryRun = body.dryRun === true;

  // Validate mode
  if (!['all', 'specific'].includes(mode)) {
    return jsonResponse({ error: 'mode must be "all" or "specific"' }, 400);
  }

  // Validate projectIds for specific mode
  if (mode === 'specific') {
    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      return jsonResponse({ error: 'projectIds array is required for "specific" mode' }, 400);
    }
    if (!projectIds.every((id) => typeof id === 'string')) {
      return jsonResponse({ error: 'projectIds must be an array of strings' }, 400);
    }
  }

  try {
    // Load current sync state
    const state = await loadSyncState(env);
    const currentKnownProjects = state.knownProjectIds ?? [];

    // Fetch current Todoist project hierarchy
    const orgMappings = parseOrgMappings(env);
    const projects = await fetchTodoistProjects(env);
    const hierarchy = buildProjectHierarchy(projects, orgMappings);
    const currentProjectIds = Array.from(hierarchy.subProjects.keys());

    let resetProjectIds: string[];
    let remainingKnownProjects: string[];

    if (mode === 'all') {
      resetProjectIds = currentProjectIds;
      remainingKnownProjects = [];
    } else {
      const projectIdsSet = new Set(projectIds.map(String));
      resetProjectIds = currentProjectIds.filter((id) => projectIdsSet.has(id));
      remainingKnownProjects = currentKnownProjects.filter((id) => !projectIdsSet.has(String(id)));
    }

    // Build response with project details
    const projectDetails = resetProjectIds.map((id) => {
      const project = hierarchy.subProjects.get(id);
      return {
        id,
        name: project?.name ?? 'unknown',
        repo: project?.fullRepo ?? 'unknown',
      };
    });

    if (dryRun) {
      return jsonResponse({
        success: true,
        dryRun: true,
        message: `Would reset ${resetProjectIds.length} project(s) for backfill on next sync`,
        resetProjects: projectDetails,
        remainingKnownProjects,
        currentKnownProjects: currentKnownProjects.length,
      });
    }

    // Actually reset the state
    const newState: SyncState = {
      ...state,
      knownProjectIds: remainingKnownProjects,
      forceBackfillNextSync: true,
      forceBackfillProjectIds: resetProjectIds,
    };

    await saveSyncState(env, newState);

    console.log(
      `Reset ${resetProjectIds.length} project(s) for auto-backfill. Remaining known: ${remainingKnownProjects.length}`
    );

    return jsonResponse({
      success: true,
      message: `Reset ${resetProjectIds.length} project(s). They will be auto-backfilled on the next sync.`,
      resetProjects: projectDetails,
      remainingKnownProjects,
      nextSyncWillBackfill: resetProjectIds.length,
    });
  } catch (error) {
    console.error('Failed to reset projects:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
}
