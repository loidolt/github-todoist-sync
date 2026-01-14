import type { Env } from '../types/env.js';
import type { SyncStatusResponse } from '../types/api.js';
import { CONSTANTS } from '../config/constants.js';
import { loadSyncState, getSyncHealthStatus } from '../state/sync-state.js';
import { jsonResponse } from '../utils/helpers.js';

/**
 * Handle GET /sync-status request
 * Returns current sync state and health information with error tracking
 */
export async function handleSyncStatus(env: Env): Promise<Response> {
  try {
    const state = await loadSyncState(env);

    const now = new Date();
    const lastPollDate = state.lastPollTime ? new Date(state.lastPollTime) : null;
    const timeSinceLastPoll = lastPollDate
      ? Math.round((now.getTime() - lastPollDate.getTime()) / 1000 / 60)
      : null;

    // Determine base health status from errors
    let healthStatus = getSyncHealthStatus(state);

    // Degrade to 'degraded' if poll is overdue
    if (
      healthStatus === 'healthy' &&
      timeSinceLastPoll !== null &&
      timeSinceLastPoll > CONSTANTS.DEGRADED_THRESHOLD_MINUTES
    ) {
      healthStatus = 'degraded';
    }

    const response: SyncStatusResponse = {
      status: healthStatus,
      lastSync: state.lastPollTime ?? 'never',
      lastGitHubSync: state.lastGitHubSync ?? 'never',
      todoistSyncTokenAge: state.todoistSyncToken === '*' ? 'full sync pending' : 'incremental',
      pollCount: state.pollCount,
      timeSinceLastPollMinutes: timeSinceLastPoll,
      pollingEnabled: true,
      pollingIntervalMinutes: CONSTANTS.POLLING_INTERVAL_MINUTES,

      // Error tracking
      lastError: state.lastError,
      recentErrorCount: state.recentErrors.length,
      consecutiveFailures: state.consecutiveFailures,
      errorCountSinceLastSuccess: state.errorCount,
      lastSuccessfulSync: state.lastSuccessfulSync ?? 'never',
    };

    // Add warning message if degraded
    if (healthStatus === 'degraded' && timeSinceLastPoll !== null) {
      if (state.consecutiveFailures > 0) {
        response.warning = `${state.consecutiveFailures} consecutive sync failure(s)`;
      } else {
        response.warning = `Last sync was more than ${CONSTANTS.DEGRADED_THRESHOLD_MINUTES} minutes ago`;
      }
    } else if (healthStatus === 'error') {
      response.warning = `${state.consecutiveFailures} consecutive sync failures`;
    }

    return new Response(JSON.stringify(response, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get sync status:', error);
    return jsonResponse(
      {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}
