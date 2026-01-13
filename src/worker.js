/**
 * GitHub ↔ Todoist Sync Worker
 *
 * Routes:
 *   POST /github-webhook   - Receives GitHub issue events, creates Todoist tasks
 *   POST /todoist-webhook  - Receives Todoist completion events, closes GitHub issues
 *   POST /backfill         - Backfill existing GitHub issues to Todoist
 *   GET  /health           - Health check endpoint
 *   GET  /api-docs         - Swagger UI documentation
 *   GET  /openapi.json     - OpenAPI specification
 */

// =============================================================================
// OpenAPI Specification
// =============================================================================

function getOpenApiSpec(baseUrl) {
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
      '/github-webhook': {
        post: {
          summary: 'GitHub webhook endpoint',
          description: 'Receives GitHub issue events and syncs them to Todoist tasks. Handles: opened, closed, edited, reopened actions.',
          tags: ['Webhooks'],
          parameters: [
            {
              name: 'X-GitHub-Event',
              in: 'header',
              required: true,
              schema: { type: 'string', example: 'issues' },
              description: 'GitHub event type',
            },
            {
              name: 'X-Hub-Signature-256',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'HMAC-SHA256 signature (sha256=...)',
            },
            {
              name: 'X-GitHub-Delivery',
              in: 'header',
              required: true,
              schema: { type: 'string', format: 'uuid' },
              description: 'Unique delivery ID for idempotency',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'GitHub webhook payload',
                },
              },
            },
          },
          responses: {
            200: { description: 'Event processed or ignored' },
            201: { description: 'Task created in Todoist' },
            401: { description: 'Invalid signature' },
            500: { description: 'Server error' },
          },
        },
      },
      '/todoist-webhook': {
        post: {
          summary: 'Todoist webhook endpoint',
          description: 'Receives Todoist events and syncs them to GitHub issues. Handles: item:added, item:completed, item:updated, item:uncompleted events.',
          tags: ['Webhooks'],
          parameters: [
            {
              name: 'X-Todoist-Hmac-SHA256',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'Base64-encoded HMAC-SHA256 signature',
            },
            {
              name: 'X-Todoist-Delivery-ID',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'Unique delivery ID for idempotency',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'Todoist webhook payload',
                },
              },
            },
          },
          responses: {
            200: { description: 'Event processed or ignored' },
            201: { description: 'Issue created in GitHub' },
            401: { description: 'Invalid signature' },
            500: { description: 'Server error' },
          },
        },
      },
      '/backfill': {
        post: {
          summary: 'Backfill existing GitHub issues to Todoist',
          description: 'Syncs existing GitHub issues to Todoist tasks. Supports single repo or entire org mode. Returns streaming NDJSON response with real-time progress.',
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
                    mode: {
                      type: 'string',
                      enum: ['single-repo', 'org'],
                      description: 'Backfill mode',
                    },
                    repo: {
                      type: 'string',
                      description: 'Repository name (required for single-repo mode)',
                      example: 'my-repo',
                    },
                    owner: {
                      type: 'string',
                      description: 'GitHub owner/org (defaults to GITHUB_ORG env var)',
                      example: 'my-org',
                    },
                    state: {
                      type: 'string',
                      enum: ['open', 'closed', 'all'],
                      default: 'open',
                      description: 'Issue state filter',
                    },
                    dryRun: {
                      type: 'boolean',
                      default: false,
                      description: 'Preview mode - no tasks will be created',
                    },
                    limit: {
                      type: 'integer',
                      minimum: 1,
                      description: 'Maximum number of issues to process',
                    },
                  },
                },
                examples: {
                  'single-repo-dry-run': {
                    summary: 'Dry run for single repo',
                    value: {
                      mode: 'single-repo',
                      repo: 'my-repo',
                      dryRun: true,
                    },
                  },
                  'single-repo': {
                    summary: 'Backfill single repo',
                    value: {
                      mode: 'single-repo',
                      repo: 'my-repo',
                    },
                  },
                  'org': {
                    summary: 'Backfill entire org',
                    value: {
                      mode: 'org',
                      state: 'open',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Streaming NDJSON response with progress',
              content: {
                'application/x-ndjson': {
                  schema: {
                    type: 'object',
                    description: 'One of: start, issue, repo_complete, complete, error',
                  },
                  examples: {
                    'start': {
                      summary: 'Start event',
                      value: { type: 'start', totalRepos: 1, dryRun: true },
                    },
                    'issue': {
                      summary: 'Issue processed',
                      value: { type: 'issue', repo: 'owner/repo', issue: 1, title: 'Fix bug', status: 'would_create' },
                    },
                    'complete': {
                      summary: 'Backfill complete',
                      value: { type: 'complete', summary: { total: 10, created: 8, skipped: 2, failed: 0 } },
                    },
                  },
                },
              },
            },
            400: { description: 'Invalid request' },
            401: { description: 'Unauthorized' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Bearer token (BACKFILL_SECRET or GITHUB_WEBHOOK_SECRET)',
        },
      },
    },
    tags: [
      { name: 'Health', description: 'Service health endpoints' },
      { name: 'Webhooks', description: 'Webhook endpoints for GitHub and Todoist' },
      { name: 'Backfill', description: 'Backfill existing issues to Todoist' },
    ],
  };
}

/**
 * Generate Swagger UI HTML page
 */
function getSwaggerUiHtml(baseUrl) {
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

// =============================================================================
// Utility Functions
// =============================================================================

const WEBHOOK_TTL = 86400; // 24 hours in seconds

/**
 * Check if a webhook has already been processed (idempotency)
 */
async function isWebhookProcessed(env, webhookId) {
  if (!webhookId || !env.WEBHOOK_CACHE) return false;
  const cached = await env.WEBHOOK_CACHE.get(webhookId);
  return cached !== null;
}

/**
 * Mark a webhook as processed
 */
async function markWebhookProcessed(env, webhookId) {
  if (!webhookId || !env.WEBHOOK_CACHE) return;
  await env.WEBHOOK_CACHE.put(webhookId, 'processed', { expirationTtl: WEBHOOK_TTL });
}

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 10000 } = options;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on client errors (4xx) - check for HTTP status in error message
      // Error messages are formatted as "API error: {status} - {message}"
      const statusMatch = error.message?.match(/API error: (\d{3})/);
      if (statusMatch) {
        const status = parseInt(statusMatch[1], 10);
        if (status >= 400 && status < 500) {
          throw error;
        }
      }

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// =============================================================================
// Main Worker Export
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    // Route requests
    if (request.method === 'POST' && url.pathname === '/github-webhook') {
      return handleGitHubWebhook(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/todoist-webhook') {
      return handleTodoistWebhook(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/backfill') {
      return handleBackfill(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Swagger UI
    if (request.method === 'GET' && (url.pathname === '/api-docs' || url.pathname === '/api-docs/')) {
      return new Response(getSwaggerUiHtml(baseUrl), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // OpenAPI spec
    if (request.method === 'GET' && url.pathname === '/openapi.json') {
      return new Response(JSON.stringify(getOpenApiSpec(baseUrl), null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // Redirect root to API docs
    if (request.method === 'GET' && url.pathname === '/') {
      return Response.redirect(`${baseUrl}/api-docs`, 302);
    }

    return new Response('Not Found', { status: 404 });
  },
};

// =============================================================================
// GitHub Webhook Handler
// =============================================================================

async function handleGitHubWebhook(request, env, ctx) {
  const body = await request.text();
  const deliveryId = request.headers.get('X-GitHub-Delivery');

  // Idempotency check - prevent duplicate processing
  if (await isWebhookProcessed(env, `github:${deliveryId}`)) {
    console.log(`Duplicate GitHub webhook: ${deliveryId}`);
    return jsonResponse({ message: 'Already processed', deliveryId }, 200);
  }

  // Validate signature
  const signature = request.headers.get('X-Hub-Signature-256');
  if (
    !signature ||
    !(await verifyGitHubSignature(body, signature, env.GITHUB_WEBHOOK_SECRET))
  ) {
    console.error('GitHub webhook signature validation failed');
    return new Response('Unauthorized', { status: 401 });
  }

  const event = request.headers.get('X-GitHub-Event');

  // Parse JSON with error handling
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    console.error('Invalid JSON payload:', e.message);
    return jsonResponse({ error: 'Invalid JSON payload' }, 400);
  }

  // Only handle issue events
  if (event !== 'issues') {
    return jsonResponse({ message: 'Event ignored', event }, 200);
  }

  const issue = payload.issue;
  const repo = payload.repository;
  let response;

  // Handle issue opened -> create Todoist task
  if (payload.action === 'opened') {
    response = await handleIssueOpened(env, issue, repo);
  }
  // Handle issue closed -> complete Todoist task
  else if (payload.action === 'closed') {
    response = await handleIssueClosed(env, issue, repo);
  }
  // Handle issue edited -> update Todoist task
  else if (payload.action === 'edited') {
    response = await handleIssueEdited(env, issue, repo, payload.changes);
  }
  // Handle issue reopened -> reopen Todoist task
  else if (payload.action === 'reopened') {
    response = await handleIssueReopened(env, issue, repo);
  }
  // Ignore other issue actions (assigned, labeled, etc.)
  else {
    response = jsonResponse(
      { message: 'Event ignored', event, action: payload.action },
      200
    );
  }

  // Mark webhook as processed in the background (non-blocking)
  // This ensures the response is returned quickly while KV write completes
  ctx.waitUntil(markWebhookProcessed(env, `github:${deliveryId}`));
  return response;
}

/**
 * Handle GitHub issue opened event -> Create Todoist task
 */
async function handleIssueOpened(env, issue, repo) {
  console.log(
    `Processing new issue: ${repo.full_name}#${issue.number} - ${issue.title}`
  );

  // Optional: Filter by repo, label, or assignee
  // Uncomment and customize the shouldSyncIssue function below if needed
  // if (!shouldSyncIssue(issue, repo, env)) {
  //   return jsonResponse({ message: 'Issue filtered out' }, 200);
  // }

  try {
    // Check for duplicate task
    if (await taskExistsForIssue(env, issue.html_url)) {
      console.log(`Task already exists for issue ${repo.full_name}#${issue.number}`);
      return jsonResponse(
        {
          message: 'Task already exists',
          issue: `${repo.full_name}#${issue.number}`,
        },
        200
      );
    }

    const task = await createTodoistTask(env, {
      title: issue.title,
      issueNumber: issue.number,
      repoName: repo.name,
      repoFullName: repo.full_name,
      issueUrl: issue.html_url,
      labels: issue.labels?.map((l) => l.name) || [],
    });

    console.log(`Created Todoist task: ${task.id}`);

    return jsonResponse(
      {
        message: 'Task created',
        taskId: task.id,
        issue: `${repo.full_name}#${issue.number}`,
      },
      201
    );
  } catch (error) {
    console.error('Failed to create Todoist task:', error);
    return jsonResponse(
      { error: 'Failed to create task', details: error.message },
      500
    );
  }
}

/**
 * Handle GitHub issue closed event -> Complete Todoist task
 */
async function handleIssueClosed(env, issue, repo) {
  console.log(
    `Processing closed issue: ${repo.full_name}#${issue.number} - ${issue.title}`
  );

  try {
    const task = await findTodoistTaskByIssueUrl(env, issue.html_url);

    if (!task) {
      console.log(`No Todoist task found for issue ${repo.full_name}#${issue.number}`);
      return jsonResponse(
        {
          message: 'No task found for issue',
          issue: `${repo.full_name}#${issue.number}`,
        },
        200
      );
    }

    await completeTodoistTask(env, task.id);
    console.log(`Completed Todoist task: ${task.id}`);

    return jsonResponse(
      {
        message: 'Task completed',
        taskId: task.id,
        issue: `${repo.full_name}#${issue.number}`,
      },
      200
    );
  } catch (error) {
    console.error('Failed to complete Todoist task:', error);
    return jsonResponse(
      { error: 'Failed to complete task', details: error.message },
      500
    );
  }
}

/**
 * Handle GitHub issue edited event -> Update Todoist task
 */
async function handleIssueEdited(env, issue, repo, changes) {
  console.log(
    `Processing edited issue: ${repo.full_name}#${issue.number} - ${issue.title}`
  );

  try {
    const task = await findTodoistTaskByIssueUrl(env, issue.html_url);

    if (!task) {
      console.log(`No Todoist task found for issue ${repo.full_name}#${issue.number}`);
      return jsonResponse(
        {
          message: 'No task found for issue',
          issue: `${repo.full_name}#${issue.number}`,
        },
        200
      );
    }

    // Only update if title changed
    if (changes?.title) {
      await updateTodoistTask(env, task.id, {
        content: `[${repo.name}#${issue.number}] ${issue.title}`,
      });
      console.log(`Updated Todoist task: ${task.id}`);
    }

    return jsonResponse(
      {
        message: 'Task updated',
        taskId: task.id,
        issue: `${repo.full_name}#${issue.number}`,
      },
      200
    );
  } catch (error) {
    console.error('Failed to update Todoist task:', error);
    return jsonResponse(
      { error: 'Failed to update task', details: error.message },
      500
    );
  }
}

/**
 * Handle GitHub issue reopened event -> Reopen Todoist task
 */
async function handleIssueReopened(env, issue, repo) {
  console.log(
    `Processing reopened issue: ${repo.full_name}#${issue.number} - ${issue.title}`
  );

  try {
    const task = await findTodoistTaskByIssueUrl(env, issue.html_url);

    if (!task) {
      console.log(`No Todoist task found for issue ${repo.full_name}#${issue.number}`);
      return jsonResponse(
        {
          message: 'No task found for issue',
          issue: `${repo.full_name}#${issue.number}`,
        },
        200
      );
    }

    await reopenTodoistTask(env, task.id);
    console.log(`Reopened Todoist task: ${task.id}`);

    return jsonResponse(
      {
        message: 'Task reopened',
        taskId: task.id,
        issue: `${repo.full_name}#${issue.number}`,
      },
      200
    );
  } catch (error) {
    console.error('Failed to reopen Todoist task:', error);
    return jsonResponse(
      { error: 'Failed to reopen task', details: error.message },
      500
    );
  }
}

/**
 * Helper to create JSON responses
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function createTodoistTask(
  env,
  { title, issueNumber, repoName, repoFullName, issueUrl, labels }
) {
  const taskData = {
    content: `[${repoName}#${issueNumber}] ${title}`,
    description: issueUrl,
    project_id: env.TODOIST_PROJECT_ID,
  };

  // Optional: Map GitHub labels to Todoist priority
  // Uncomment if you want priority mapping
  // taskData.priority = getPriority(labels);

  return withRetry(async () => {
    const response = await fetch('https://api.todoist.com/rest/v2/tasks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(taskData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  });
}

/**
 * Check if a Todoist task already exists for the given GitHub issue URL
 * Uses filter parameter to avoid pagination issues with large projects
 */
async function taskExistsForIssue(env, issueUrl) {
  try {
    const task = await findTodoistTaskByIssueUrl(env, issueUrl);
    return task !== null && task !== undefined;
  } catch (error) {
    console.error(`Failed to check for existing task: ${error.message}`);
    return false; // Assume not exists on error, let creation attempt proceed
  }
}

/**
 * Find a Todoist task by its GitHub issue URL in the description
 * Uses filter parameter to search efficiently (avoids pagination issues)
 */
async function findTodoistTaskByIssueUrl(env, issueUrl) {
  return withRetry(async () => {
    // Use filter to narrow down search - search for the issue URL
    const filterQuery = encodeURIComponent(`search: ${issueUrl}`);
    const response = await fetch(
      `https://api.todoist.com/rest/v2/tasks?project_id=${env.TODOIST_PROJECT_ID}&filter=${filterQuery}`,
      {
        headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
      }
    );

    if (!response.ok) {
      // Fall back to fetching all tasks if filter fails
      const allResponse = await fetch(
        `https://api.todoist.com/rest/v2/tasks?project_id=${env.TODOIST_PROJECT_ID}`,
        {
          headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
        }
      );
      if (!allResponse.ok) {
        throw new Error(`Todoist API error: ${allResponse.status}`);
      }
      const tasks = await allResponse.json();
      return tasks.find((t) => t.description?.includes(issueUrl));
    }

    const tasks = await response.json();
    // Double-check the description match since filter is fuzzy
    return tasks.find((t) => t.description?.includes(issueUrl));
  });
}

/**
 * Complete (close) a Todoist task by ID
 */
async function completeTodoistTask(env, taskId) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.todoist.com/rest/v2/tasks/${taskId}/close`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }
  });
}

/**
 * Update a Todoist task
 */
async function updateTodoistTask(env, taskId, updates) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.todoist.com/rest/v2/tasks/${taskId}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }
  });
}

/**
 * Reopen a completed Todoist task
 */
async function reopenTodoistTask(env, taskId) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.todoist.com/rest/v2/tasks/${taskId}/reopen`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }
  });
}

// =============================================================================
// Todoist Webhook Handler
// =============================================================================

async function handleTodoistWebhook(request, env, ctx) {
  const body = await request.text();
  const deliveryId = request.headers.get('X-Todoist-Delivery-ID');

  // Idempotency check - prevent duplicate processing
  if (await isWebhookProcessed(env, `todoist:${deliveryId}`)) {
    console.log(`Duplicate Todoist webhook: ${deliveryId}`);
    return jsonResponse({ message: 'Already processed', deliveryId }, 200);
  }

  // Validate signature
  const signature = request.headers.get('X-Todoist-Hmac-SHA256');
  if (
    !signature ||
    !(await verifyTodoistSignature(body, signature, env.TODOIST_WEBHOOK_SECRET))
  ) {
    console.error('Todoist webhook signature validation failed');
    return new Response('Unauthorized', { status: 401 });
  }

  // Parse JSON with error handling
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    console.error('Invalid JSON payload:', e.message);
    return jsonResponse({ error: 'Invalid JSON payload' }, 400);
  }

  const task = payload.event_data;
  let response;

  // Handle item:added -> create GitHub issue
  if (payload.event_name === 'item:added') {
    response = await handleTaskAdded(env, task);
  }
  // Handle item:completed -> close GitHub issue
  else if (payload.event_name === 'item:completed') {
    response = await handleTaskCompleted(env, task);
  }
  // Handle item:updated -> update GitHub issue
  else if (payload.event_name === 'item:updated') {
    response = await handleTaskUpdated(env, task, payload.event_data_extra);
  }
  // Handle item:uncompleted -> reopen GitHub issue
  else if (payload.event_name === 'item:uncompleted') {
    response = await handleTaskUncompleted(env, task);
  }
  // Ignore other events
  else {
    response = jsonResponse({ message: 'Event ignored', event: payload.event_name }, 200);
  }

  // Mark webhook as processed in the background (non-blocking)
  // This ensures the response is returned quickly while KV write completes
  ctx.waitUntil(markWebhookProcessed(env, `todoist:${deliveryId}`));
  return response;
}

/**
 * Handle Todoist task completed event -> Close GitHub issue
 */
async function handleTaskCompleted(env, task) {
  console.log(`Processing completed task: ${task.id} - ${task.content}`);

  // Extract GitHub URL from task description
  const githubInfo = parseGitHubUrl(task.description);

  if (!githubInfo) {
    console.log('No GitHub URL found in task description, skipping');
    return jsonResponse({ message: 'No GitHub URL in task, skipped' }, 200);
  }

  console.log(
    `Closing GitHub issue: ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`
  );

  try {
    await closeGitHubIssue(env, githubInfo);

    return jsonResponse(
      {
        message: 'Issue closed',
        issue: `${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`,
      },
      200
    );
  } catch (error) {
    console.error('Failed to close GitHub issue:', error);
    return jsonResponse(
      { error: 'Failed to close issue', details: error.message },
      500
    );
  }
}

/**
 * Handle Todoist task updated event -> Update GitHub issue
 */
async function handleTaskUpdated(env, task, extraData) {
  console.log(`Processing updated task: ${task.id} - ${task.content}`);

  // Extract GitHub URL from task description
  const githubInfo = parseGitHubUrl(task.description);

  if (!githubInfo) {
    console.log('No GitHub URL found in task description, skipping');
    return jsonResponse({ message: 'No GitHub URL in task, skipped' }, 200);
  }

  // Check if content actually changed (not just completion status)
  // event_data_extra contains previous state
  if (!extraData?.old_item?.content || extraData.old_item.content === task.content) {
    console.log('Task content unchanged, skipping');
    return jsonResponse({ message: 'Content unchanged, skipped' }, 200);
  }

  console.log(
    `Updating GitHub issue: ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`
  );

  try {
    // Strip the [repo#issue] prefix before updating GitHub
    const cleanTitle = stripTodoistPrefix(task.content);
    await updateGitHubIssue(env, githubInfo, {
      title: cleanTitle,
    });

    return jsonResponse(
      {
        message: 'Issue updated',
        issue: `${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`,
      },
      200
    );
  } catch (error) {
    console.error('Failed to update GitHub issue:', error);
    return jsonResponse(
      { error: 'Failed to update issue', details: error.message },
      500
    );
  }
}

/**
 * Handle Todoist task uncompleted event -> Reopen GitHub issue
 */
async function handleTaskUncompleted(env, task) {
  console.log(`Processing uncompleted task: ${task.id} - ${task.content}`);

  // Extract GitHub URL from task description
  const githubInfo = parseGitHubUrl(task.description);

  if (!githubInfo) {
    console.log('No GitHub URL found in task description, skipping');
    return jsonResponse({ message: 'No GitHub URL in task, skipped' }, 200);
  }

  console.log(
    `Reopening GitHub issue: ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`
  );

  try {
    await reopenGitHubIssue(env, githubInfo);

    return jsonResponse(
      {
        message: 'Issue reopened',
        issue: `${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`,
      },
      200
    );
  } catch (error) {
    console.error('Failed to reopen GitHub issue:', error);
    return jsonResponse(
      { error: 'Failed to reopen issue', details: error.message },
      500
    );
  }
}

function parseGitHubUrl(description) {
  if (!description) return null;

  // Match: https://github.com/{owner}/{repo}/issues/{number}
  const match = description.match(
    /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/
  );

  if (!match) return null;

  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10),
  };
}

/**
 * Strip the [repo#issue] prefix from Todoist task content
 * Pattern: [repo-name#123] Title here -> Title here
 */
function stripTodoistPrefix(content) {
  if (!content) return content;
  // Match: [repo-name#123] or [owner/repo#123] at the start
  return content.replace(/^\[[\w./-]+#\d+\]\s*/, '');
}

async function closeGitHubIssue(env, { owner, repo, issueNumber }) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitHub-Todoist-Sync-Worker',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: 'closed',
          state_reason: 'completed',
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  });
}

/**
 * Update a GitHub issue
 */
async function updateGitHubIssue(env, { owner, repo, issueNumber }, updates) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitHub-Todoist-Sync-Worker',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  });
}

/**
 * Reopen a closed GitHub issue
 */
async function reopenGitHubIssue(env, { owner, repo, issueNumber }) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitHub-Todoist-Sync-Worker',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: 'open',
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  });
}

/**
 * Create a new GitHub issue
 */
async function createGitHubIssue(env, { owner, repo, title, body }) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitHub-Todoist-Sync-Worker',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, body }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  });
}

/**
 * Update a Todoist task's description
 */
async function updateTodoistTaskDescription(env, taskId, description) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.todoist.com/rest/v2/tasks/${taskId}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }
  });
}

/**
 * Extract owner/repo from task labels
 * Supports two formats:
 *   - "owner/repo" → returns { owner, repo }
 *   - "repo" → returns { owner: null, repo } (will use GITHUB_ORG as owner)
 * Returns null if no valid repo label found
 */
function getRepoFromLabels(labels) {
  if (!labels || labels.length === 0) return null;

  // Skip common non-repo labels
  const skipLabels = ['github', 'sync', 'todo', 'task', 'urgent', 'high', 'medium', 'low'];

  // First pass: look for explicit owner/repo labels
  // Supports dashes, underscores, and dots in names (e.g., my_org/repo.js)
  for (const label of labels) {
    const match = label.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }

  // Second pass: look for simple repo names
  for (const label of labels) {
    const labelLower = label.toLowerCase();
    if (!skipLabels.includes(labelLower) && /^[\w.-]+$/.test(label)) {
      return { owner: null, repo: label };
    }
  }

  return null;
}

/**
 * Handle Todoist task added event -> Create GitHub issue
 */
async function handleTaskAdded(env, task) {
  console.log(`Processing new task: ${task.id} - ${task.content}`);

  // Loop prevention: skip if task already has a GitHub URL (was created from GitHub)
  if (task.description && task.description.includes('github.com')) {
    console.log('Task already has GitHub URL, skipping (likely created from GitHub)');
    return jsonResponse({ message: 'Task has GitHub URL, skipped (loop prevention)' }, 200);
  }

  // Get owner/repo from task labels
  const repoInfo = getRepoFromLabels(task.labels);

  if (!repoInfo) {
    console.log('No repo label found on task, skipping');
    return jsonResponse({ message: 'No repo label found, skipped' }, 200);
  }

  // Determine owner: use explicit owner from label, or fall back to GITHUB_ORG
  const owner = repoInfo.owner || env.GITHUB_ORG;

  if (!owner) {
    console.log('No owner specified and GITHUB_ORG not configured, skipping');
    return jsonResponse({ message: 'No owner specified and GITHUB_ORG not configured, skipped' }, 200);
  }

  const repo = repoInfo.repo;
  console.log(`Creating GitHub issue in ${owner}/${repo}`);

  try {
    // Create the GitHub issue
    const issue = await createGitHubIssue(env, {
      owner: owner,
      repo: repo,
      title: task.content,
      body: task.description || `Created from Todoist task: ${task.id}`,
    });

    console.log(`Created GitHub issue: ${issue.html_url}`);

    // Update the Todoist task description with the issue URL
    await updateTodoistTaskDescription(env, task.id, issue.html_url);
    console.log(`Updated Todoist task ${task.id} with issue URL`);

    return jsonResponse(
      {
        message: 'Issue created',
        issueUrl: issue.html_url,
        issueNumber: issue.number,
        taskId: task.id,
      },
      201
    );
  } catch (error) {
    console.error('Failed to create GitHub issue:', error);
    return jsonResponse(
      { error: 'Failed to create issue', details: error.message },
      500
    );
  }
}

// =============================================================================
// Backfill Handler
// =============================================================================

/**
 * Simple token bucket rate limiter
 */
class RateLimiter {
  constructor(requestsPerMinute) {
    this.requestsPerMinute = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.lastRefill = Date.now();
  }

  async waitForToken() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillAmount = (elapsed / 60000) * this.requestsPerMinute;
    this.tokens = Math.min(this.requestsPerMinute, this.tokens + refillAmount);
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitTime = ((1 - this.tokens) / this.requestsPerMinute) * 60000;
      await sleep(waitTime);
      this.tokens = 1;
    }
    this.tokens -= 1;
  }
}

/**
 * Verify backfill request authentication
 * Uses BACKFILL_SECRET if set, falls back to GITHUB_WEBHOOK_SECRET
 */
function verifyBackfillAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);
  const secret = env.BACKFILL_SECRET || env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    console.error('No BACKFILL_SECRET or GITHUB_WEBHOOK_SECRET configured');
    return false;
  }

  return timingSafeEqual(token, secret);
}

/**
 * Validate backfill request body
 */
function validateBackfillRequest(body, env) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const { mode, repo, owner, state = 'open', dryRun = false, limit } = body;

  // Validate mode
  if (!mode || !['single-repo', 'org'].includes(mode)) {
    return { valid: false, error: 'mode must be "single-repo" or "org"' };
  }

  // Validate repo for single-repo mode
  if (mode === 'single-repo' && !repo) {
    return { valid: false, error: 'repo is required for single-repo mode' };
  }

  // Validate owner exists (from body or env)
  const effectiveOwner = owner || env.GITHUB_ORG;
  if (!effectiveOwner) {
    return { valid: false, error: 'owner is required (or set GITHUB_ORG env var)' };
  }

  // Validate state
  if (!['open', 'closed', 'all'].includes(state)) {
    return { valid: false, error: 'state must be "open", "closed", or "all"' };
  }

  // Validate limit if provided
  if (limit !== undefined && (typeof limit !== 'number' || limit < 1)) {
    return { valid: false, error: 'limit must be a positive number' };
  }

  return {
    valid: true,
    params: {
      mode,
      repo,
      owner: effectiveOwner,
      state,
      dryRun: Boolean(dryRun),
      limit: limit || Infinity,
    },
  };
}

/**
 * Fetch GitHub issues with pagination
 * Async generator that yields issues one at a time
 */
async function* fetchGitHubIssues(env, owner, repo, options = {}) {
  const { state = 'open', limit = Infinity } = options;
  let page = 1;
  let fetched = 0;

  while (fetched < limit) {
    const params = new URLSearchParams({
      state,
      per_page: String(Math.min(100, limit - fetched)),
      page: String(page),
      sort: 'created',
      direction: 'asc',
    });

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues?${params}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitHub-Todoist-Sync-Worker',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    const issues = await response.json();

    for (const issue of issues) {
      // Skip pull requests (they appear in issues API)
      if (issue.pull_request) continue;

      yield issue;
      fetched++;
      if (fetched >= limit) break;
    }

    // No more pages if we got fewer than requested
    if (issues.length < 100) break;
    page++;
  }
}

/**
 * Fetch all repositories for a GitHub organization
 */
async function* fetchOrgRepos(env, org) {
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      sort: 'name',
    });

    const response = await fetch(
      `https://api.github.com/orgs/${org}/repos?${params}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitHub-Todoist-Sync-Worker',
        },
      }
    );

    if (!response.ok) {
      // Try user repos if org repos fails (for personal accounts)
      if (response.status === 404) {
        yield* fetchUserRepos(env, org);
        return;
      }
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    const repos = await response.json();

    for (const repo of repos) {
      yield { owner: org, name: repo.name };
    }

    if (repos.length < 100) break;
    page++;
  }
}

/**
 * Fetch all repositories for a GitHub user (fallback for fetchOrgRepos)
 */
async function* fetchUserRepos(env, user) {
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      sort: 'name',
    });

    const response = await fetch(
      `https://api.github.com/users/${user}/repos?${params}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitHub-Todoist-Sync-Worker',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    const repos = await response.json();

    for (const repo of repos) {
      yield { owner: user, name: repo.name };
    }

    if (repos.length < 100) break;
    page++;
  }
}

/**
 * Process a single issue for backfill
 */
async function processBackfillIssue(env, issue, repoFullName, dryRun) {
  try {
    const exists = await taskExistsForIssue(env, issue.html_url);

    if (exists) {
      return { status: 'skipped', reason: 'already_exists' };
    }

    if (dryRun) {
      return { status: 'would_create' };
    }

    const [owner, repoName] = repoFullName.split('/');
    const task = await createTodoistTask(env, {
      title: issue.title,
      issueNumber: issue.number,
      repoName: repoName,
      repoFullName: repoFullName,
      issueUrl: issue.html_url,
      labels: issue.labels?.map((l) => l.name) || [],
    });

    return { status: 'created', taskId: task.id };
  } catch (error) {
    console.error(`Failed to process issue ${repoFullName}#${issue.number}:`, error);
    return { status: 'failed', error: error.message };
  }
}

/**
 * Main backfill handler
 * Supports streaming NDJSON response for real-time progress
 */
async function handleBackfill(request, env, ctx) {
  // Authenticate
  if (!verifyBackfillAuth(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Parse and validate request
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const validation = validateBackfillRequest(body, env);
  if (!validation.valid) {
    return jsonResponse({ error: validation.error }, 400);
  }

  const { mode, repo, owner, state, dryRun, limit } = validation.params;

  // Create streaming response
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const writeJSON = async (data) => {
    await writer.write(encoder.encode(JSON.stringify(data) + '\n'));
  };

  // Process and stream results (not using ctx.waitUntil so stream is properly consumed)
  const processBackfill = async () => {
    const summary = { total: 0, created: 0, skipped: 0, failed: 0 };
    const githubLimiter = new RateLimiter(60);
    const todoistLimiter = new RateLimiter(300);

    try {
      // Get list of repos to process
      let repos;
      if (mode === 'single-repo') {
        repos = [{ owner, name: repo }];
      } else {
        // Collect repos from async generator
        repos = [];
        for await (const r of fetchOrgRepos(env, owner)) {
          repos.push(r);
        }
      }

      await writeJSON({ type: 'start', totalRepos: repos.length, dryRun });

      for (const repoInfo of repos) {
        const repoFullName = `${repoInfo.owner}/${repoInfo.name}`;
        let repoIssueCount = 0;

        try {
          await githubLimiter.waitForToken();

          for await (const issue of fetchGitHubIssues(env, repoInfo.owner, repoInfo.name, {
            state,
            limit,
          })) {
            repoIssueCount++;

            if (!dryRun) {
              await todoistLimiter.waitForToken();
            }

            const result = await processBackfillIssue(env, issue, repoFullName, dryRun);

            summary.total++;
            if (result.status === 'created' || result.status === 'would_create') {
              summary.created++;
            } else if (result.status === 'skipped') {
              summary.skipped++;
            } else {
              summary.failed++;
            }

            await writeJSON({
              type: 'issue',
              repo: repoFullName,
              issue: issue.number,
              title: issue.title,
              ...result,
            });
          }

          await writeJSON({
            type: 'repo_complete',
            repo: repoFullName,
            issues: repoIssueCount,
          });
        } catch (error) {
          console.error(`Failed to process repo ${repoFullName}:`, error);
          await writeJSON({
            type: 'repo_error',
            repo: repoFullName,
            error: error.message,
          });
        }
      }

      await writeJSON({ type: 'complete', summary });
    } catch (error) {
      console.error('Backfill failed:', error);
      await writeJSON({ type: 'error', error: error.message, summary });
    } finally {
      await writer.close();
    }
  };

  // Start processing (don't await - let it stream)
  processBackfill();

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
    },
  });
}

// =============================================================================
// Signature Verification
// =============================================================================

async function verifyGitHubSignature(payload, signature, secret) {
  // GitHub sends: sha256=<hex-digest>
  const expectedSig = signature.replace('sha256=', '');
  const computed = await hmacSha256Hex(payload, secret);
  return timingSafeEqual(expectedSig, computed);
}

async function verifyTodoistSignature(payload, signature, secret) {
  // Todoist sends: base64-encoded HMAC-SHA256
  const computed = await hmacSha256Base64(payload, secret);
  return timingSafeEqual(signature, computed);
}

async function hmacSha256Hex(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message)
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256Base64(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message)
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// =============================================================================
// Optional: Filtering and Priority Mapping
// =============================================================================

/**
 * Uncomment and customize to filter which issues get synced
 */
// function shouldSyncIssue(issue, repo, env) {
//   // Only sync issues from specific repos
//   const allowedRepos = ['my-repo', 'another-repo'];
//   if (!allowedRepos.includes(repo.name)) {
//     return false;
//   }
//
//   // Only sync issues with specific labels
//   const syncLabels = ['todo', 'task'];
//   const hasLabel = issue.labels?.some((l) => syncLabels.includes(l.name));
//   if (!hasLabel) {
//     return false;
//   }
//
//   return true;
// }

/**
 * Map GitHub labels to Todoist priority (1-4, where 4 is highest)
 */
// function getPriority(labels) {
//   if (labels.includes('urgent') || labels.includes('critical')) return 4;
//   if (labels.includes('high')) return 3;
//   if (labels.includes('medium')) return 2;
//   return 1;
// }
