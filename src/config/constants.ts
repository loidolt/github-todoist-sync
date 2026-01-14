/**
 * Application constants
 */
export const CONSTANTS = {
  // Pagination
  PER_PAGE: 100,

  // Rate limits (requests per minute)
  GITHUB_RATE_LIMIT: 60,
  TODOIST_RATE_LIMIT: 300,

  // Retry configuration
  MAX_RETRIES: 3,
  BASE_RETRY_DELAY_MS: 1000,
  MAX_RETRY_DELAY_MS: 10000,

  // Sync health thresholds
  DEGRADED_THRESHOLD_MINUTES: 30,

  // Polling interval
  POLLING_INTERVAL_MINUTES: 15,

  // API endpoints
  TODOIST_API_BASE: 'https://api.todoist.com',
  GITHUB_API_BASE: 'https://api.github.com',

  // Batch operation limits (to stay within Cloudflare subrequest limits)
  // Cloudflare free tier: 50 subrequests, paid: 1000
  // We use conservative limits to leave room for other operations
  BATCH_TASK_LIMIT: 50, // Max tasks to batch in one Sync API call
  MAX_TASKS_PER_SYNC: 30, // Max tasks to create per sync cycle
  MAX_SECTIONS_PER_SYNC: 10, // Max sections to create per sync cycle

  // Completed tasks buffer (look back window)
  COMPLETED_TASK_BUFFER_MINUTES: 30,

  // KV keys
  SYNC_STATE_KEY: 'sync:state',

  // Error tracking
  MAX_RECENT_ERRORS: 10,
  CONSECUTIVE_FAILURE_THRESHOLD: 3,
} as const;

export type Constants = typeof CONSTANTS;
