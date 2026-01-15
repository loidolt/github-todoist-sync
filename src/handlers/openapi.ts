/**
 * OpenAPI specification generator
 */
export function getOpenApiSpec(baseUrl: string): object {
  return {
    openapi: '3.0.3',
    info: {
      title: 'GitHub ↔ Todoist Sync API',
      description: 'Bidirectional sync between GitHub issues and Todoist tasks',
      version: '1.0.0',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/health': {
        get: {
          summary: 'Health check',
          description: 'Returns the health status of the service',
          tags: ['Health'],
          responses: {
            200: {
              description: 'Service is healthy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'ok' },
                      timestamp: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/sync-status': {
        get: {
          summary: 'Sync status',
          description: 'Returns the current polling sync status and health information',
          tags: ['Health'],
          responses: {
            200: {
              description: 'Sync status returned',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['healthy', 'degraded', 'error'], example: 'healthy' },
                      lastSync: { type: 'string', example: '2024-01-15T10:30:00Z' },
                      lastGitHubSync: { type: 'string', example: '2024-01-15T10:30:00Z' },
                      todoistSyncTokenAge: { type: 'string', example: 'incremental' },
                      pollCount: { type: 'integer', example: 42 },
                      timeSinceLastPollMinutes: { type: 'integer', example: 5 },
                      pollingEnabled: { type: 'boolean', example: true },
                      pollingIntervalMinutes: { type: 'integer', example: 15 },
                      warning: { type: 'string', description: 'Present if status is degraded' },
                      lastError: { type: 'object', description: 'Most recent error info' },
                      recentErrorCount: { type: 'integer', description: 'Number of recent errors' },
                      consecutiveFailures: { type: 'integer', description: 'Consecutive sync failures' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/reset-projects': {
        post: {
          summary: 'Reset known projects to trigger auto-backfill',
          description: 'Resets the known projects list so that the next sync will auto-backfill all (or specified) projects. Requires Bearer authentication.',
          tags: ['Admin'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    mode: { type: 'string', enum: ['all', 'specific'], default: 'all' },
                    projectIds: { type: 'array', items: { type: 'string' } },
                    dryRun: { type: 'boolean', default: false },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Projects reset successfully' },
            400: { description: 'Invalid request' },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/backfill': {
        post: {
          summary: 'Backfill existing GitHub issues to Todoist',
          description: 'Syncs existing GitHub issues to Todoist tasks. Returns streaming NDJSON response.',
          tags: ['Backfill'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['mode'],
                  properties: {
                    mode: { type: 'string', enum: ['single-repo', 'org', 'projects', 'create-mappings'] },
                    repo: { type: 'string' },
                    owner: { type: 'string' },
                    state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
                    dryRun: { type: 'boolean', default: false },
                    limit: { type: 'integer', minimum: 1 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Streaming NDJSON response with progress' },
            400: { description: 'Invalid request' },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/trigger-sync': {
        post: {
          summary: 'Manually trigger sync',
          description: 'Manually triggers a full bidirectional sync cycle. Useful for debugging or immediate sync needs. Requires Bearer authentication.',
          tags: ['Admin'],
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Sync completed successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      duration: { type: 'integer', description: 'Duration in milliseconds', example: 1234 },
                      results: {
                        type: 'object',
                        properties: {
                          github: {
                            type: 'object',
                            properties: {
                              processed: { type: 'integer' },
                              created: { type: 'integer' },
                              updated: { type: 'integer' },
                              completed: { type: 'integer' },
                              reopened: { type: 'integer' },
                              sectionUpdated: { type: 'integer' },
                              errors: { type: 'integer' },
                            },
                          },
                          todoist: {
                            type: 'object',
                            properties: {
                              processed: { type: 'integer' },
                              closed: { type: 'integer', description: 'GitHub issues closed from completed Todoist tasks' },
                              reopened: { type: 'integer' },
                              createdIssues: { type: 'integer' },
                              milestoneUpdated: { type: 'integer' },
                              errors: { type: 'integer' },
                            },
                          },
                          autoBackfill: {
                            type: 'object',
                            properties: {
                              newProjects: { type: 'integer' },
                              issues: { type: 'integer' },
                              created: { type: 'integer' },
                              skipped: { type: 'integer' },
                              errors: { type: 'integer' },
                            },
                          },
                        },
                      },
                      error: { type: 'string', description: 'Error message if sync failed' },
                      warning: { type: 'string', description: 'Warning message if applicable' },
                    },
                  },
                },
              },
            },
            401: { description: 'Unauthorized - invalid or missing Bearer token' },
            500: { description: 'Sync failed with error' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Bearer token (BACKFILL_SECRET)',
        },
      },
    },
    tags: [
      { name: 'Health', description: 'Service health and sync status endpoints' },
      { name: 'Admin', description: 'Administrative endpoints for managing sync state' },
      { name: 'Backfill', description: 'Backfill existing issues to Todoist' },
    ],
  };
}

/**
 * Swagger UI HTML page generator
 */
export function getSwaggerUiHtml(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitHub-Todoist Sync API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css">
  <style>
    body { margin: 0; }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '${baseUrl}/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout',
        defaultModelsExpandDepth: -1,
        tryItOutEnabled: true
      });
    };
  </script>
</body>
</html>`;
}
