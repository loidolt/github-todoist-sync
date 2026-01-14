import type { Env } from '../types/env.js';

/**
 * Timing-safe string comparison to prevent timing attacks
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verify backfill endpoint authentication
 * Returns true if the Bearer token matches BACKFILL_SECRET
 */
export function verifyBackfillAuth(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);

  if (!env.BACKFILL_SECRET) {
    console.error('No BACKFILL_SECRET configured');
    return false;
  }

  return timingSafeEqual(token, env.BACKFILL_SECRET);
}

/**
 * Backfill request parameters after validation
 */
export interface BackfillParams {
  mode: 'single-repo' | 'org' | 'projects' | 'create-mappings';
  repo?: string;
  owner?: string;
  state: 'open' | 'closed' | 'all';
  dryRun: boolean;
  limit: number;
}

/**
 * Backfill validation result
 */
export type BackfillValidation =
  | { valid: true; params: BackfillParams }
  | { valid: false; error: string };

/**
 * Validate backfill request body
 */
export function validateBackfillRequest(body: unknown, env: Env): BackfillValidation {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const {
    mode,
    repo,
    owner,
    state = 'open',
    dryRun = false,
    limit,
  } = body as Record<string, unknown>;

  // Validate mode
  if (!mode || !['single-repo', 'org', 'projects', 'create-mappings'].includes(mode as string)) {
    return {
      valid: false,
      error: 'mode must be "single-repo", "org", "projects", or "create-mappings"',
    };
  }

  // Validate repo for single-repo mode
  if (mode === 'single-repo' && !repo) {
    return { valid: false, error: 'repo is required for single-repo mode' };
  }

  // For "projects" and "create-mappings" modes, owner is not required (uses ORG_MAPPINGS)
  // For other modes, owner is required
  if (!['projects', 'create-mappings'].includes(mode as string) && !owner) {
    return { valid: false, error: 'owner is required for single-repo and org modes' };
  }

  // For "projects" and "create-mappings" modes, ORG_MAPPINGS is required
  if (['projects', 'create-mappings'].includes(mode as string) && !env.ORG_MAPPINGS) {
    return { valid: false, error: 'ORG_MAPPINGS env var is required for this mode' };
  }

  // Validate state
  if (!['open', 'closed', 'all'].includes(state as string)) {
    return { valid: false, error: 'state must be "open", "closed", or "all"' };
  }

  // Validate limit if provided
  if (limit !== undefined && (typeof limit !== 'number' || limit < 1)) {
    return { valid: false, error: 'limit must be a positive number' };
  }

  return {
    valid: true,
    params: {
      mode: mode as BackfillParams['mode'],
      repo: repo as string | undefined,
      owner: owner as string | undefined,
      state: state as BackfillParams['state'],
      dryRun: Boolean(dryRun),
      limit: typeof limit === 'number' ? limit : Infinity,
    },
  };
}
