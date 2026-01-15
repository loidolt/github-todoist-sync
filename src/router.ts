import type { Env } from './types/env.js';
import { Logger } from './logging/logger.js';
import { getOpenApiSpec, getSwaggerUiHtml } from './handlers/openapi.js';
import { handleHealth } from './handlers/health.js';
import { handleSyncStatus } from './handlers/sync-status.js';
import { handleResetProjects } from './handlers/reset-projects.js';
import { handleBackfill } from './handlers/backfill.js';
import { handleTriggerSync } from './handlers/trigger-sync.js';

/**
 * Route HTTP requests to appropriate handlers
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger
): Promise<Response> {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const { pathname } = url;
  const method = request.method;

  logger.debug(`${method} ${pathname}`, { path: pathname, method });

  // POST /reset-projects
  if (method === 'POST' && pathname === '/reset-projects') {
    return handleResetProjects(request, env);
  }

  // POST /backfill
  if (method === 'POST' && pathname === '/backfill') {
    return handleBackfill(request, env, ctx);
  }

  // POST /trigger-sync - manually trigger sync for debugging
  if (method === 'POST' && pathname === '/trigger-sync') {
    return handleTriggerSync(request, env);
  }

  // GET /health
  if (method === 'GET' && pathname === '/health') {
    return handleHealth();
  }

  // GET /sync-status
  if (method === 'GET' && pathname === '/sync-status') {
    return handleSyncStatus(env);
  }

  // GET /api-docs
  if (method === 'GET' && (pathname === '/api-docs' || pathname === '/api-docs/')) {
    return new Response(getSwaggerUiHtml(baseUrl), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // GET /openapi.json
  if (method === 'GET' && pathname === '/openapi.json') {
    return new Response(JSON.stringify(getOpenApiSpec(baseUrl), null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // GET / - redirect to API docs
  if (method === 'GET' && pathname === '/') {
    return Response.redirect(`${baseUrl}/api-docs`, 302);
  }

  return new Response('Not Found', { status: 404 });
}
