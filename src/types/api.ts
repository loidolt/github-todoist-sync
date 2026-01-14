import type { ErrorInfo } from './sync-state.js';

/**
 * Health check response
 */
export interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

/**
 * Sync status endpoint response
 */
export interface SyncStatusResponse {
  status: 'healthy' | 'degraded' | 'error';
  lastSync: string;
  lastGitHubSync: string;
  todoistSyncTokenAge: string;
  pollCount: number;
  timeSinceLastPollMinutes: number | null;
  pollingEnabled: boolean;
  pollingIntervalMinutes: number;
  warning?: string;

  /** Most recent error info */
  lastError?: ErrorInfo | null;

  /** Count of errors in the recent errors window */
  recentErrorCount: number;

  /** Number of consecutive sync failures */
  consecutiveFailures: number;

  /** Total errors since last successful sync */
  errorCountSinceLastSuccess: number;

  /** ISO timestamp of last fully successful sync */
  lastSuccessfulSync: string;
}

/**
 * Backfill request body
 */
export interface BackfillRequest {
  mode: 'single-repo' | 'org' | 'projects' | 'create-mappings';
  repo?: string;
  owner?: string;
  state?: 'open' | 'closed' | 'all';
  dryRun?: boolean;
  limit?: number;
}

/**
 * Backfill streaming response events
 */
export type BackfillEvent =
  | { type: 'start'; totalRepos: number; dryRun: boolean }
  | {
      type: 'issue';
      repo: string;
      issue: number;
      title: string;
      status: 'created' | 'would_create' | 'skipped' | 'failed';
      reason?: string;
      error?: string;
    }
  | { type: 'repo_complete'; repo: string; issues: number }
  | {
      type: 'complete';
      summary: {
        total: number;
        created: number;
        skipped: number;
        failed: number;
      };
    }
  | { type: 'error'; message: string };

/**
 * Reset projects request body
 */
export interface ResetProjectsRequest {
  mode?: 'all' | 'specific';
  projectIds?: string[];
  dryRun?: boolean;
}

/**
 * Reset projects response
 */
export interface ResetProjectsResponse {
  success: boolean;
  message: string;
  resetProjects: Array<{
    id: string;
    name: string;
    repo: string;
  }>;
  remainingKnownProjects: string[];
  nextSyncWillBackfill: number;
}

/**
 * Sync action result types
 */
export type SyncAction =
  | { action: 'created'; issue: string; section?: string | null }
  | { action: 'updated'; issue: string }
  | { action: 'completed'; issue: string }
  | { action: 'reopened'; issue: string }
  | { action: 'section_updated'; issue: string; section: string | null }
  | { action: 'unchanged'; issue: string }
  | { action: 'skipped'; reason: string; issue?: string; taskId?: string }
  | { action: 'error'; error: string; taskId?: string };
