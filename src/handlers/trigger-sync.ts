import type { Env } from '../types/env.js';
import { Logger, LogLevel } from '../logging/logger.js';
import { verifyBackfillAuth } from '../utils/auth.js';
import { performBidirectionalSync } from '../sync/orchestrator.js';

/**
 * Handle POST /trigger-sync
 * Manually trigger a sync cycle for debugging purposes
 * Requires Bearer auth with BACKFILL_SECRET
 */
export async function handleTriggerSync(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify authentication
  if (!verifyBackfillAuth(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const correlationId = crypto.randomUUID();
  const logger = new Logger(LogLevel.INFO, correlationId);

  logger.info('Manual sync triggered via /trigger-sync endpoint');

  try {
    const result = await performBidirectionalSync(env, logger);

    return new Response(
      JSON.stringify({
        success: result.success,
        duration: result.duration,
        results: result.results,
        error: result.error,
        warning: result.warning,
      }, null, 2),
      {
        status: result.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Manual sync failed', error);

    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
