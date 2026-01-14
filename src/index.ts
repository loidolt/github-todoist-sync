import type { Env } from './types/env.js';
import { Logger, LogLevel } from './logging/logger.js';
import { handleRequest } from './router.js';
import { performBidirectionalSync } from './sync/orchestrator.js';

/**
 * Cloudflare Worker entry point
 * Handles both HTTP requests and scheduled sync jobs
 */
export default {
  /**
   * Handle HTTP requests
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const logger = new Logger(LogLevel.INFO);

    try {
      return await handleRequest(request, env, ctx, logger);
    } catch (error) {
      logger.error('Unhandled error in fetch handler', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  /**
   * Handle scheduled sync jobs (cron trigger)
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const logger = new Logger(LogLevel.INFO);
    logger.info('Scheduled sync triggered', { scheduledTime: new Date(event.scheduledTime).toISOString() });

    // Use waitUntil to ensure the sync completes even if the handler returns early
    ctx.waitUntil(
      performBidirectionalSync(env, logger)
        .then((result) => {
          if (result.success) {
            logger.info('Scheduled sync completed successfully', {
              duration: result.duration,
              github: result.results.github,
              todoist: result.results.todoist,
              autoBackfill: result.results.autoBackfill,
            });
          } else {
            logger.error('Scheduled sync failed', undefined, {
              duration: result.duration,
              error: result.error,
            });
          }
        })
        .catch((error) => {
          logger.error('Unhandled error in scheduled sync', error);
        })
    );
  },
};
