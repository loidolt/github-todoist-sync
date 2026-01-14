import type { Env } from '../types/env.js';
import type { SyncState, ErrorInfo } from '../types/sync-state.js';
import { CONSTANTS } from '../config/constants.js';
import { Logger } from '../logging/logger.js';

/**
 * Get default sync state for initial run
 */
export function getDefaultSyncState(): SyncState {
  return {
    // Core sync state
    lastGitHubSync: null,
    todoistSyncToken: '*',
    lastPollTime: null,
    lastCompletedSync: null,
    pollCount: 0,
    knownProjectIds: [],

    // Force backfill flags
    forceBackfillNextSync: false,
    forceBackfillProjectIds: [],

    // Error tracking
    lastError: null,
    recentErrors: [],
    errorCount: 0,
    consecutiveFailures: 0,
    lastSuccessfulSync: null,
  };
}

/**
 * Load sync state from KV store
 * Returns default state if not found
 * Merges stored state with defaults to handle new fields gracefully
 */
export async function loadSyncState(env: Env, logger?: Logger): Promise<SyncState> {
  if (!env.WEBHOOK_CACHE) {
    logger?.warn('WEBHOOK_CACHE not available, using default state');
    return getDefaultSyncState();
  }

  try {
    const stored = await env.WEBHOOK_CACHE.get(CONSTANTS.SYNC_STATE_KEY, 'json');
    if (!stored) {
      logger?.debug('No stored sync state found, using defaults');
      return getDefaultSyncState();
    }

    // Merge with defaults to handle new fields gracefully
    return {
      ...getDefaultSyncState(),
      ...(stored as Partial<SyncState>),
    };
  } catch (error) {
    logger?.error('Failed to load sync state', error);
    return getDefaultSyncState();
  }
}

/**
 * Save sync state to KV store
 */
export async function saveSyncState(env: Env, state: SyncState, logger?: Logger): Promise<void> {
  if (!env.WEBHOOK_CACHE) {
    logger?.warn('WEBHOOK_CACHE not available, cannot save sync state');
    return;
  }

  try {
    await env.WEBHOOK_CACHE.put(CONSTANTS.SYNC_STATE_KEY, JSON.stringify(state));
    logger?.debug('Sync state saved successfully');
  } catch (error) {
    logger?.error('Failed to save sync state', error);
  }
}

/**
 * Extract error code from an error object or message
 */
function extractErrorCode(error: Error | unknown): string | undefined {
  if (error instanceof Error) {
    // Look for HTTP status codes in the message
    const statusMatch = error.message.match(/API error: (\d{3})/);
    if (statusMatch) {
      return `HTTP_${statusMatch[1]}`;
    }

    // Check for error name
    if (error.name && error.name !== 'Error') {
      return error.name;
    }
  }
  return undefined;
}

/**
 * Record an error in the sync state
 * Adds to recent errors (rolling window) and updates counters
 */
export function recordError(state: SyncState, operation: string, error: Error | unknown): SyncState {
  const errorMessage = error instanceof Error ? error.message : String(error);

  const errorInfo: ErrorInfo = {
    timestamp: new Date().toISOString(),
    operation,
    message: errorMessage,
    code: extractErrorCode(error),
  };

  // Rolling window of recent errors
  const recentErrors = [errorInfo, ...state.recentErrors].slice(0, CONSTANTS.MAX_RECENT_ERRORS);

  return {
    ...state,
    lastError: errorInfo,
    recentErrors,
    errorCount: state.errorCount + 1,
    consecutiveFailures: state.consecutiveFailures + 1,
  };
}

/**
 * Clear error state after a successful sync
 * Resets consecutive failures and records successful sync time
 */
export function clearErrors(state: SyncState): SyncState {
  return {
    ...state,
    lastError: null,
    errorCount: 0,
    consecutiveFailures: 0,
    lastSuccessfulSync: new Date().toISOString(),
    // Keep recentErrors for debugging - they'll naturally roll off
  };
}

/**
 * Check if sync is in a degraded or error state based on consecutive failures
 */
export function getSyncHealthStatus(state: SyncState): 'healthy' | 'degraded' | 'error' {
  if (state.consecutiveFailures >= CONSTANTS.CONSECUTIVE_FAILURE_THRESHOLD) {
    return 'error';
  }
  if (state.consecutiveFailures > 0) {
    return 'degraded';
  }
  return 'healthy';
}
