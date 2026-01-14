/**
 * Error information for tracking sync failures
 */
export interface ErrorInfo {
  /** ISO timestamp when the error occurred */
  timestamp: string;

  /** Operation that failed (e.g., 'github-polling', 'todoist-sync') */
  operation: string;

  /** Error message */
  message: string;

  /** Error code if available */
  code?: string;
}

/**
 * Sync state persisted in KV store
 */
export interface SyncState {
  /** ISO timestamp of last GitHub poll, null if never synced */
  lastGitHubSync: string | null;

  /** Todoist sync token for incremental sync, '*' for full sync */
  todoistSyncToken: string;

  /** ISO timestamp of last poll execution */
  lastPollTime: string | null;

  /** ISO timestamp of last completed tasks poll */
  lastCompletedSync: string | null;

  /** Total number of successful poll cycles */
  pollCount: number;

  /** Array of known Todoist project IDs (for auto-backfill detection) */
  knownProjectIds: string[];

  /** Flag to force backfill on next sync cycle */
  forceBackfillNextSync?: boolean;

  /** Specific project IDs to force backfill */
  forceBackfillProjectIds?: string[];

  /** Most recent error (null if last sync was successful) */
  lastError: ErrorInfo | null;

  /** Rolling window of recent errors (max 10) */
  recentErrors: ErrorInfo[];

  /** Total error count since last fully successful sync */
  errorCount: number;

  /** Consecutive failures (resets to 0 on success) */
  consecutiveFailures: number;

  /** ISO timestamp of last sync with zero errors */
  lastSuccessfulSync: string | null;
}

/**
 * Results from a bidirectional sync operation
 */
export interface SyncResults {
  github: {
    processed: number;
    created: number;
    updated: number;
    completed: number;
    reopened: number;
    sectionUpdated: number;
    errors: number;
  };
  todoist: {
    processed: number;
    closed: number;
    reopened: number;
    createdIssues: number;
    milestoneUpdated: number;
    errors: number;
  };
  autoBackfill: {
    newProjects: number;
    issues: number;
    created: number;
    skipped: number;
    errors: number;
  };
}
