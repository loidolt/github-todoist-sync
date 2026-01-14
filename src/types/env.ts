/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  /** KV namespace for sync state and task mappings */
  WEBHOOK_CACHE: KVNamespace;

  /** GitHub Personal Access Token with repo scope */
  GITHUB_TOKEN: string;

  /** Todoist API token */
  TODOIST_API_TOKEN: string;

  /** JSON mapping: Todoist parent project ID -> GitHub org name */
  ORG_MAPPINGS: string;

  /** Bearer token for /backfill endpoint authentication (optional) */
  BACKFILL_SECRET?: string;
}
