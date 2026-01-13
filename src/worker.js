/**
 * GitHub ↔ Todoist Sync Worker
 *
 * Polling-based bidirectional sync between GitHub issues and Todoist tasks.
 * Uses Cloudflare Cron Triggers for scheduled sync every 15 minutes.
 *
 * Routes:
 *   GET  /health           - Health check endpoint
 *   GET  /sync-status      - Polling sync status and health
 *   POST /backfill         - Backfill existing GitHub issues to Todoist
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
                    },
                  },
                },
              },
            },
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
      { name: 'Health', description: 'Service health and sync status endpoints' },
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
// Sync State Management (for polling-based sync)
// =============================================================================

const SYNC_STATE_KEY = 'sync:state';

/**
 * Load sync state from KV store
 * Returns default state if not found
 */
async function loadSyncState(env) {
  if (!env.WEBHOOK_CACHE) {
    return getDefaultSyncState();
  }

  try {
    const state = await env.WEBHOOK_CACHE.get(SYNC_STATE_KEY, 'json');
    return state || getDefaultSyncState();
  } catch (error) {
    console.error('Failed to load sync state:', error);
    return getDefaultSyncState();
  }
}

/**
 * Save sync state to KV store
 */
async function saveSyncState(env, state) {
  if (!env.WEBHOOK_CACHE) {
    console.warn('WEBHOOK_CACHE not available, cannot save sync state');
    return;
  }

  try {
    await env.WEBHOOK_CACHE.put(SYNC_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('Failed to save sync state:', error);
  }
}

/**
 * Get default sync state for initial run
 */
function getDefaultSyncState() {
  return {
    lastGitHubSync: null, // ISO 8601 timestamp, null = full sync
    todoistSyncToken: '*', // '*' = full sync for Todoist
    lastPollTime: null,
    pollCount: 0,
  };
}

// =============================================================================
// Organization Mappings (Todoist Project ID -> GitHub Org)
// =============================================================================

/**
 * Parse ORG_MAPPINGS environment variable
 * Format: {"todoist-project-id": "github-org", ...}
 * Returns Map of projectId -> githubOrg
 */
function parseOrgMappings(env) {
  if (!env.ORG_MAPPINGS) {
    // Fallback to legacy single-project mode
    if (env.TODOIST_PROJECT_ID && env.GITHUB_ORG) {
      console.log('Using legacy single-project mode (TODOIST_PROJECT_ID + GITHUB_ORG)');
      return new Map([[env.TODOIST_PROJECT_ID, env.GITHUB_ORG]]);
    }
    console.warn('No ORG_MAPPINGS configured');
    return new Map();
  }

  try {
    const mappings = JSON.parse(env.ORG_MAPPINGS);
    const map = new Map(Object.entries(mappings));
    console.log(`Loaded ${map.size} org mapping(s)`);
    return map;
  } catch (error) {
    console.error('Failed to parse ORG_MAPPINGS:', error);
    return new Map();
  }
}

/**
 * Fetch all Todoist projects using Sync API
 * Returns array of project objects with id, name, parent_id
 */
async function fetchTodoistProjects(env) {
  const response = await fetch('https://api.todoist.com/sync/v9/sync', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      sync_token: '*',
      resource_types: '["projects"]',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.projects || [];
}

/**
 * Build project hierarchy from org mappings
 * Returns object with:
 *   - parentProjects: Map of projectId -> { id, name, githubOrg }
 *   - subProjects: Map of projectId -> { id, name, parentId, repoName, githubOrg }
 *   - repoToProject: Map of "owner/repo" -> projectId (for task creation)
 */
function buildProjectHierarchy(projects, orgMappings) {
  const parentProjects = new Map();
  const subProjects = new Map();
  const repoToProject = new Map();

  // First pass: identify parent projects from org mappings
  for (const project of projects) {
    const projectId = String(project.id);
    if (orgMappings.has(projectId)) {
      parentProjects.set(projectId, {
        id: projectId,
        name: project.name,
        githubOrg: orgMappings.get(projectId),
      });
    }
  }

  // Second pass: identify sub-projects (children of parent projects)
  for (const project of projects) {
    const parentId = project.parent_id ? String(project.parent_id) : null;
    if (parentId && parentProjects.has(parentId)) {
      const parent = parentProjects.get(parentId);
      const projectId = String(project.id);
      const repoName = project.name;
      const fullRepo = `${parent.githubOrg}/${repoName}`;

      subProjects.set(projectId, {
        id: projectId,
        name: repoName,
        parentId: parentId,
        repoName: repoName,
        githubOrg: parent.githubOrg,
        fullRepo: fullRepo,
      });

      repoToProject.set(fullRepo, projectId);
    }
  }

  console.log(`Found ${parentProjects.size} parent project(s), ${subProjects.size} sub-project(s)`);
  return { parentProjects, subProjects, repoToProject };
}

// =============================================================================
// GitHub Polling
// =============================================================================

/**
 * Poll GitHub for issues updated since last sync
 * Uses project hierarchy to determine which repos to sync
 * Returns array of issues with their current state and target project info
 */
async function pollGitHubChanges(env, since, projectHierarchy) {
  const issues = [];
  const { subProjects } = projectHierarchy;

  // Get unique repos from sub-projects
  const repos = Array.from(subProjects.values()).map(p => ({
    owner: p.githubOrg,
    name: p.repoName,
    projectId: p.id,
  }));

  console.log(`Polling ${repos.length} repo(s) from Todoist project hierarchy`);

  for (const repo of repos) {
    try {
      const repoIssues = await fetchGitHubIssuesSince(env, repo.owner, repo.name, since);
      // Add project info to each issue
      for (const issue of repoIssues) {
        issue._todoistProjectId = repo.projectId;
      }
      issues.push(...repoIssues);
    } catch (error) {
      console.error(`Failed to fetch issues from ${repo.owner}/${repo.name}:`, error);
      // Continue with other repos
    }
  }

  return issues;
}

/**
 * Fetch GitHub issues updated since a given timestamp
 */
async function fetchGitHubIssuesSince(env, owner, repo, since) {
  const issues = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      state: 'all', // Get both open and closed issues
      sort: 'updated',
      direction: 'asc',
      per_page: '100',
      page: String(page),
    });

    if (since) {
      params.set('since', since);
    }

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

    const pageIssues = await response.json();

    for (const issue of pageIssues) {
      // Skip pull requests (they appear in issues API)
      if (issue.pull_request) continue;

      // Add repo info for context
      issues.push({
        ...issue,
        _repoOwner: owner,
        _repoName: repo,
        _repoFullName: `${owner}/${repo}`,
      });
    }

    // No more pages if we got fewer than 100
    if (pageIssues.length < 100) break;
    page++;
  }

  return issues;
}

// =============================================================================
// Todoist Polling (using Sync API)
// =============================================================================

/**
 * Poll Todoist for task changes using the Sync API
 * Filters to only tasks in sub-projects from the project hierarchy
 */
async function pollTodoistChanges(env, syncToken, projectHierarchy) {
  const response = await fetch('https://api.todoist.com/sync/v9/sync', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      sync_token: syncToken,
      resource_types: '["items"]',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const { subProjects } = projectHierarchy;

  // Filter to only tasks in sub-projects (repos)
  const projectTasks = (data.items || []).filter((item) => {
    const projectId = String(item.project_id);
    return subProjects.has(projectId);
  });

  // Enrich tasks with repo info from project hierarchy
  for (const task of projectTasks) {
    const projectId = String(task.project_id);
    const subProject = subProjects.get(projectId);
    if (subProject) {
      task._githubOrg = subProject.githubOrg;
      task._repoName = subProject.repoName;
      task._fullRepo = subProject.fullRepo;
    }
  }

  return {
    tasks: projectTasks,
    newSyncToken: data.sync_token,
    fullSync: data.full_sync || false,
  };
}

/**
 * Get a single Todoist task by ID using REST API
 * Used to get current state of a task during reconciliation
 */
async function getTodoistTask(env, taskId) {
  const response = await fetch(
    `https://api.todoist.com/rest/v2/tasks/${taskId}`,
    {
      headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
    }
  );

  if (!response.ok) {
    if (response.status === 404) return null;
    const errorText = await response.text();
    throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// =============================================================================
// Reconciliation Logic
// =============================================================================

/**
 * Sync a GitHub issue to Todoist
 * Creates task if missing, updates state if changed
 * Uses _todoistProjectId from issue to determine which sub-project to create task in
 */
async function syncIssueToTodoist(env, issue) {
  const issueUrl = issue.html_url;
  const repoName = issue._repoName;
  const repoFullName = issue._repoFullName;
  const projectId = issue._todoistProjectId;

  // Find existing task
  const task = await findTodoistTaskByIssueUrl(env, issueUrl);

  if (!task) {
    // No task exists - create if issue is open
    if (issue.state === 'open') {
      console.log(`Creating task for open issue: ${repoFullName}#${issue.number} in project ${projectId}`);
      await createTodoistTask(env, {
        title: issue.title,
        issueNumber: issue.number,
        repoName: repoName,
        repoFullName: repoFullName,
        issueUrl: issueUrl,
        projectId: projectId, // Create in the sub-project for this repo
        labels: issue.labels?.map((l) => l.name) || [],
      });
      return { action: 'created', issue: `${repoFullName}#${issue.number}` };
    }
    return { action: 'skipped', reason: 'closed_no_task', issue: `${repoFullName}#${issue.number}` };
  }

  // Task exists - sync state
  const taskCompleted = task.is_completed;

  if (issue.state === 'closed' && !taskCompleted) {
    console.log(`Completing task for closed issue: ${repoFullName}#${issue.number}`);
    await completeTodoistTask(env, task.id);
    return { action: 'completed', issue: `${repoFullName}#${issue.number}` };
  }

  if (issue.state === 'open' && taskCompleted) {
    console.log(`Reopening task for reopened issue: ${repoFullName}#${issue.number}`);
    await reopenTodoistTask(env, task.id);
    return { action: 'reopened', issue: `${repoFullName}#${issue.number}` };
  }

  // Check for title changes
  const expectedTitle = `[${repoName}#${issue.number}] ${issue.title}`;
  if (task.content !== expectedTitle) {
    console.log(`Updating task title for issue: ${repoFullName}#${issue.number}`);
    await updateTodoistTask(env, task.id, { content: expectedTitle });
    return { action: 'updated', issue: `${repoFullName}#${issue.number}` };
  }

  return { action: 'unchanged', issue: `${repoFullName}#${issue.number}` };
}

/**
 * Sync a Todoist task to GitHub
 * Uses project hierarchy to determine org/repo (from _githubOrg and _repoName added during polling)
 * Falls back to parsing GitHub URL from description for tasks created from GitHub
 */
async function syncTaskToGitHub(env, task) {
  // First check if task has GitHub URL (was created from GitHub issue)
  const githubInfo = parseGitHubUrl(task.description);

  if (githubInfo) {
    // Task was created from GitHub - sync completion state back
    const issue = await getGitHubIssue(env, githubInfo);
    if (!issue) {
      console.warn(`GitHub issue not found: ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`);
      return { action: 'skipped', reason: 'issue_not_found', taskId: task.id };
    }

    const taskCompleted = task.is_completed || task.checked === 1;

    if (taskCompleted && issue.state === 'open') {
      console.log(`Closing issue for completed task: ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`);
      await closeGitHubIssue(env, githubInfo);
      return { action: 'closed', issue: `${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}` };
    }

    if (!taskCompleted && issue.state === 'closed') {
      console.log(`Reopening issue for uncompleted task: ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`);
      await reopenGitHubIssue(env, githubInfo);
      return { action: 'reopened', issue: `${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}` };
    }

    return { action: 'unchanged', taskId: task.id };
  }

  // No GitHub URL - task was created in Todoist, might need to create GitHub issue
  // Use project hierarchy info (added during polling) to determine repo
  if (!task._githubOrg || !task._repoName) {
    return { action: 'skipped', reason: 'no_repo_info', taskId: task.id };
  }

  // Skip completed tasks - don't create closed issues
  if (task.is_completed || task.checked === 1) {
    return { action: 'skipped', reason: 'completed_no_issue', taskId: task.id };
  }

  // Create GitHub issue for this task
  console.log(`Creating GitHub issue for task: ${task._fullRepo} - ${task.content}`);
  try {
    const issue = await createGitHubIssue(env, {
      owner: task._githubOrg,
      repo: task._repoName,
      title: task.content,
      body: task.description || `Created from Todoist task: ${task.id}`,
    });

    // Update task description with GitHub URL (for bidirectional sync)
    await updateTodoistTaskDescription(env, task.id, issue.html_url);
    console.log(`Created GitHub issue: ${issue.html_url}`);

    return { action: 'created_issue', issue: issue.html_url, taskId: task.id };
  } catch (error) {
    console.error(`Failed to create GitHub issue for task ${task.id}:`, error);
    return { action: 'error', error: error.message, taskId: task.id };
  }
}

/**
 * Get a GitHub issue by owner/repo/number
 */
async function getGitHubIssue(env, { owner, repo, issueNumber }) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'GitHub-Todoist-Sync-Worker',
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) return null;
    const errorText = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// =============================================================================
// Bidirectional Sync Orchestrator
// =============================================================================

/**
 * Perform bidirectional sync between GitHub and Todoist
 * Called by the scheduled handler
 *
 * Uses Todoist project hierarchy to determine which repos to sync:
 * - Parent projects map to GitHub organizations (via ORG_MAPPINGS)
 * - Sub-projects map to repositories (sub-project name = repo name)
 */
async function performBidirectionalSync(env) {
  console.log('Starting bidirectional sync...');
  const startTime = Date.now();

  // Load current sync state
  const state = await loadSyncState(env);
  console.log(`Last sync: ${state.lastPollTime || 'never'}, Poll count: ${state.pollCount}`);

  const results = {
    github: { processed: 0, created: 0, updated: 0, completed: 0, reopened: 0, errors: 0 },
    todoist: { processed: 0, closed: 0, reopened: 0, created_issues: 0, errors: 0 },
  };

  try {
    // Parse org mappings and build project hierarchy
    const orgMappings = parseOrgMappings(env);
    if (orgMappings.size === 0) {
      console.warn('No org mappings configured, skipping sync');
      return { success: false, error: 'No ORG_MAPPINGS configured', results };
    }

    // Fetch Todoist projects and build hierarchy
    console.log('Fetching Todoist project hierarchy...');
    const projects = await fetchTodoistProjects(env);
    const projectHierarchy = buildProjectHierarchy(projects, orgMappings);

    if (projectHierarchy.subProjects.size === 0) {
      console.warn('No sub-projects found under mapped parent projects');
      return { success: true, duration: Date.now() - startTime, results, warning: 'No repos configured' };
    }

    // Poll GitHub for changes
    console.log(`Polling GitHub for issues updated since: ${state.lastGitHubSync || 'beginning'}`);
    const githubIssues = await pollGitHubChanges(env, state.lastGitHubSync, projectHierarchy);
    console.log(`Found ${githubIssues.length} GitHub issues to process`);

    // Process GitHub -> Todoist sync
    for (const issue of githubIssues) {
      try {
        const result = await syncIssueToTodoist(env, issue);
        results.github.processed++;
        if (result.action === 'created') results.github.created++;
        else if (result.action === 'updated') results.github.updated++;
        else if (result.action === 'completed') results.github.completed++;
        else if (result.action === 'reopened') results.github.reopened++;
      } catch (error) {
        console.error(`Error syncing issue ${issue._repoFullName}#${issue.number}:`, error);
        results.github.errors++;
      }
    }

    // Poll Todoist for changes
    console.log(`Polling Todoist with sync token: ${state.todoistSyncToken === '*' ? 'full sync' : 'incremental'}`);
    const { tasks: todoistTasks, newSyncToken, fullSync } = await pollTodoistChanges(env, state.todoistSyncToken, projectHierarchy);
    console.log(`Found ${todoistTasks.length} Todoist tasks to process (full_sync: ${fullSync})`);

    // Process Todoist -> GitHub sync
    for (const task of todoistTasks) {
      try {
        const result = await syncTaskToGitHub(env, task);
        results.todoist.processed++;
        if (result.action === 'closed') results.todoist.closed++;
        else if (result.action === 'reopened') results.todoist.reopened++;
        else if (result.action === 'created_issue') results.todoist.created_issues++;
      } catch (error) {
        console.error(`Error syncing task ${task.id}:`, error);
        results.todoist.errors++;
      }
    }

    // Save updated sync state
    const newState = {
      lastGitHubSync: new Date().toISOString(),
      todoistSyncToken: newSyncToken,
      lastPollTime: new Date().toISOString(),
      pollCount: state.pollCount + 1,
    };
    await saveSyncState(env, newState);

    const duration = Date.now() - startTime;
    console.log(`Sync completed in ${duration}ms:`, JSON.stringify(results));

    return { success: true, duration, results };
  } catch (error) {
    console.error('Sync failed:', error);
    return { success: false, error: error.message, results };
  }
}

/**
 * Handle GET /sync-status request
 * Returns current sync state and health information
 */
async function handleSyncStatus(env) {
  try {
    const state = await loadSyncState(env);

    const now = new Date();
    const lastPollDate = state.lastPollTime ? new Date(state.lastPollTime) : null;
    const timeSinceLastPoll = lastPollDate
      ? Math.round((now - lastPollDate) / 1000 / 60)
      : null;

    const status = {
      status: 'healthy',
      lastSync: state.lastPollTime || 'never',
      lastGitHubSync: state.lastGitHubSync || 'never',
      todoistSyncTokenAge: state.todoistSyncToken === '*' ? 'full sync pending' : 'incremental',
      pollCount: state.pollCount,
      timeSinceLastPollMinutes: timeSinceLastPoll,
      pollingEnabled: true,
      pollingIntervalMinutes: 15,
    };

    // Mark as unhealthy if last poll was more than 30 minutes ago
    if (timeSinceLastPoll !== null && timeSinceLastPoll > 30) {
      status.status = 'degraded';
      status.warning = 'Last sync was more than 30 minutes ago';
    }

    return new Response(JSON.stringify(status, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get sync status:', error);
    return new Response(
      JSON.stringify({ status: 'error', error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// =============================================================================
// Main Worker Export
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    // Route requests
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

    // Sync status endpoint
    if (request.method === 'GET' && url.pathname === '/sync-status') {
      return handleSyncStatus(env);
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

  /**
   * Scheduled handler for cron-triggered polling sync
   * Runs every 15 minutes to sync GitHub issues and Todoist tasks
   */
  async scheduled(controller, env, ctx) {
    console.log('Cron trigger fired at', new Date().toISOString());

    try {
      const result = await performBidirectionalSync(env);
      console.log('Scheduled sync result:', JSON.stringify(result));
    } catch (error) {
      console.error('Scheduled sync failed:', error);
      // Don't throw - let the cron job complete even if sync fails
      // Errors are logged and will be visible in Cloudflare dashboard
    }
  },
};

// =============================================================================
// Shared Helper Functions
// =============================================================================

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
  { title, issueNumber, repoName, repoFullName, issueUrl, projectId, labels }
) {
  const taskData = {
    content: `[${repoName}#${issueNumber}] ${title}`,
    description: issueUrl,
    // Use provided projectId (from sub-project) or fall back to legacy env var
    project_id: projectId || env.TODOIST_PROJECT_ID,
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
// GitHub URL Parsing and API Functions
// =============================================================================

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
// Utility Functions for Authentication
// =============================================================================

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
