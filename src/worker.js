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
// Constants
// =============================================================================

const CONSTANTS = {
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
};

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
                    mode: {
                      type: 'string',
                      enum: ['all', 'specific'],
                      default: 'all',
                      description: 'Reset mode: "all" resets all projects, "specific" resets only specified project IDs',
                    },
                    projectIds: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Project IDs to reset (only for "specific" mode)',
                    },
                    dryRun: {
                      type: 'boolean',
                      default: false,
                      description: 'Preview mode - shows what would be reset without making changes',
                    },
                  },
                },
                examples: {
                  'reset-all': {
                    summary: 'Reset all projects',
                    value: { mode: 'all' },
                  },
                  'reset-specific': {
                    summary: 'Reset specific projects',
                    value: { mode: 'specific', projectIds: ['1001', '1002'] },
                  },
                  'dry-run': {
                    summary: 'Preview reset',
                    value: { mode: 'all', dryRun: true },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Projects reset successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      message: { type: 'string' },
                      resetProjects: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Project IDs that will be backfilled on next sync',
                      },
                      remainingKnownProjects: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Project IDs that will NOT be backfilled',
                      },
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
                      enum: ['single-repo', 'org', 'projects'],
                      description: 'Backfill mode: single-repo, org, or projects (recommended)',
                    },
                    repo: {
                      type: 'string',
                      description: 'Repository name (required for single-repo mode)',
                      example: 'my-repo',
                    },
                    owner: {
                      type: 'string',
                      description: 'GitHub owner/org (required for single-repo and org modes)',
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
                      owner: 'my-org',
                      state: 'open',
                    },
                  },
                  'projects': {
                    summary: 'Backfill using Todoist project hierarchy (recommended)',
                    value: {
                      mode: 'projects',
                      dryRun: true,
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
 * Add random jitter to prevent thundering herd
 * Returns a random value between 0 and maxMs
 */
function jitter(maxMs) {
  return Math.floor(Math.random() * maxMs);
}

/**
 * Check if a Todoist task is completed
 * Handles both REST API (is_completed) and Sync API (checked) formats
 */
function isTaskCompleted(task) {
  return task.is_completed === true || task.checked === 1;
}

/**
 * Retry wrapper with exponential backoff and jitter
 * Handles 429 rate limit errors with Retry-After header support
 */
async function withRetry(fn, options = {}) {
  const {
    maxRetries = CONSTANTS.MAX_RETRIES,
    baseDelay = CONSTANTS.BASE_RETRY_DELAY_MS,
    maxDelay = CONSTANTS.MAX_RETRY_DELAY_MS,
  } = options;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check for HTTP status in error message
      // Error messages are formatted as "API error: {status} - {message}"
      const statusMatch = error.message?.match(/API error: (\d{3})/);
      if (statusMatch) {
        const status = parseInt(statusMatch[1], 10);

        // Handle rate limiting (429) - always retry with backoff
        if (status === 429) {
          if (attempt < maxRetries) {
            // Use Retry-After header if available, otherwise exponential backoff
            const retryAfterMs = error.retryAfter || baseDelay * Math.pow(2, attempt);
            const waitTime = Math.min(retryAfterMs, maxDelay) + jitter(100);
            console.log(`Rate limited (429), waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`);
            await sleep(waitTime);
            continue;
          }
        }

        // Don't retry on other 4xx client errors
        if (status >= 400 && status < 500) {
          throw error;
        }
      }

      if (attempt < maxRetries) {
        // Exponential backoff with jitter
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        const jitteredDelay = delay + jitter(delay * 0.1); // Add 10% jitter
        console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${jitteredDelay}ms`);
        await sleep(jitteredDelay);
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
    knownProjectIds: [], // Track known sub-project IDs for auto-backfill detection
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
// Section Management (for milestone-based sections)
// =============================================================================

/**
 * Fetch all sections for a Todoist project
 * Returns array of section objects { id, name, project_id, order }
 */
async function fetchSectionsForProject(env, projectId) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.todoist.com/rest/v2/sections?project_id=${projectId}`,
      {
        headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  });
}

/**
 * Fetch sections for multiple projects and build caches
 * Returns { sectionCache: Map<projectId, Map<name, id>>, sectionIdToName: Map<projectId, Map<id, name>> }
 */
async function fetchSectionsForProjects(env, projectIds) {
  const sectionCache = new Map(); // projectId -> Map<sectionName, sectionId>
  const sectionIdToName = new Map(); // projectId -> Map<sectionId, sectionName>

  // Fetch sections for each project (could parallelize but respecting rate limits)
  for (const projectId of projectIds) {
    try {
      const sections = await fetchSectionsForProject(env, projectId);

      const nameToId = new Map();
      const idToName = new Map();

      for (const section of sections) {
        nameToId.set(section.name, section.id);
        idToName.set(String(section.id), section.name);
      }

      sectionCache.set(String(projectId), nameToId);
      sectionIdToName.set(String(projectId), idToName);
    } catch (error) {
      console.error(`Failed to fetch sections for project ${projectId}:`, error);
      // Continue with other projects, use empty maps for this one
      sectionCache.set(String(projectId), new Map());
      sectionIdToName.set(String(projectId), new Map());
    }
  }

  const totalSections = Array.from(sectionCache.values()).reduce((sum, m) => sum + m.size, 0);
  console.log(`Fetched ${totalSections} sections across ${projectIds.length} projects`);

  return { sectionCache, sectionIdToName };
}

/**
 * Create a new section in a Todoist project
 */
async function createTodoistSection(env, projectId, name) {
  return withRetry(async () => {
    const response = await fetch('https://api.todoist.com/rest/v2/sections', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ project_id: projectId, name }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  });
}

/**
 * Get or create a section for a milestone name
 * Uses cache to minimize API calls, creates section if not found
 */
async function getOrCreateSection(env, projectId, milestoneName, sectionCache) {
  const projectIdStr = String(projectId);

  // Check cache
  let projectSections = sectionCache.get(projectIdStr);
  if (projectSections?.has(milestoneName)) {
    return projectSections.get(milestoneName);
  }

  // Refresh cache from API (in case section was created by another process)
  try {
    const sections = await fetchSectionsForProject(env, projectId);
    projectSections = new Map();
    for (const section of sections) {
      projectSections.set(section.name, section.id);
    }
    sectionCache.set(projectIdStr, projectSections);

    // Check again after refresh
    if (projectSections.has(milestoneName)) {
      return projectSections.get(milestoneName);
    }
  } catch (error) {
    console.error(`Failed to refresh sections for project ${projectId}:`, error);
  }

  // Create new section
  try {
    console.log(`Creating section "${milestoneName}" in project ${projectId}`);
    const section = await createTodoistSection(env, projectId, milestoneName);

    // Update cache
    if (!projectSections) {
      projectSections = new Map();
      sectionCache.set(projectIdStr, projectSections);
    }
    projectSections.set(milestoneName, section.id);

    return section.id;
  } catch (error) {
    // Handle race condition - section might have been created by another request
    if (error.message.includes('already exists') || error.message.includes('409')) {
      console.log(`Section "${milestoneName}" already exists, refreshing cache`);
      const sections = await fetchSectionsForProject(env, projectId);
      for (const section of sections) {
        if (section.name === milestoneName) {
          sectionCache.get(projectIdStr)?.set(milestoneName, section.id);
          return section.id;
        }
      }
    }
    throw error;
  }
}

/**
 * Update a Todoist task's section
 * sectionId can be null to remove from section
 */
async function updateTodoistTaskSection(env, taskId, sectionId) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.todoist.com/rest/v2/tasks/${taskId}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ section_id: sectionId }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }
  });
}

// =============================================================================
// Milestone Management (for section-based milestones)
// =============================================================================

/**
 * Fetch all milestones for a GitHub repository
 * Returns array of milestone objects { number, title, state, ... }
 */
async function fetchMilestonesForRepo(env, owner, repo) {
  return withRetry(async () => {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/milestones?state=all&per_page=100`,
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

    return response.json();
  });
}

/**
 * Fetch milestones for a repo and build caches
 * Returns { milestoneCache: Map<title, number>, milestoneNumberToTitle: Map<number, title> }
 */
async function getMilestoneCaches(env, owner, repo, existingCache = null) {
  const repoKey = `${owner}/${repo}`;

  // Return existing cache if available
  if (existingCache?.has(repoKey)) {
    return existingCache.get(repoKey);
  }

  const milestones = await fetchMilestonesForRepo(env, owner, repo);

  const titleToNumber = new Map();
  const numberToTitle = new Map();

  for (const milestone of milestones) {
    titleToNumber.set(milestone.title, milestone.number);
    numberToTitle.set(milestone.number, milestone.title);
  }

  const caches = { titleToNumber, numberToTitle };

  if (existingCache) {
    existingCache.set(repoKey, caches);
  }

  return caches;
}

/**
 * Get milestone number from title for a repo
 * Returns null if milestone doesn't exist
 */
async function getMilestoneNumber(env, owner, repo, milestoneTitle, milestoneCache) {
  const caches = await getMilestoneCaches(env, owner, repo, milestoneCache);
  return caches.titleToNumber.get(milestoneTitle) || null;
}

/**
 * Get milestone title from number for a repo
 * Returns null if milestone doesn't exist
 */
async function getMilestoneTitle(env, owner, repo, milestoneNumber, milestoneCache) {
  const caches = await getMilestoneCaches(env, owner, repo, milestoneCache);
  return caches.numberToTitle.get(milestoneNumber) || null;
}

/**
 * Update a GitHub issue's milestone
 * milestoneNumber can be null to clear milestone
 */
async function updateGitHubIssueMilestone(env, owner, repo, issueNumber, milestoneNumber) {
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
        body: JSON.stringify({ milestone: milestoneNumber }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  });
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
      per_page: String(CONSTANTS.PER_PAGE),
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

    // No more pages if we got fewer than requested
    if (pageIssues.length < CONSTANTS.PER_PAGE) break;
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

// =============================================================================
// Reconciliation Logic
// =============================================================================

/**
 * Sync a GitHub issue to Todoist
 * Creates task if missing, updates state if changed
 * Uses _todoistProjectId from issue to determine which sub-project to create task in
 * Handles milestone-to-section mapping when sectionCache is provided
 */
async function syncIssueToTodoist(env, issue, sectionCache = null) {
  const issueUrl = issue.html_url;
  const repoName = issue._repoName;
  const repoFullName = issue._repoFullName;
  const projectId = issue._todoistProjectId;

  // Determine target section based on milestone
  let targetSectionId = null;
  const milestoneName = issue.milestone?.title;
  if (milestoneName && sectionCache) {
    try {
      targetSectionId = await getOrCreateSection(env, projectId, milestoneName, sectionCache);
    } catch (error) {
      console.error(`Failed to get/create section for milestone "${milestoneName}":`, error);
      // Continue without section - don't fail the sync
    }
  }

  // Find existing task
  const task = await findTodoistTaskByIssueUrl(env, issueUrl);

  if (!task) {
    // No task exists - create if issue is open
    if (issue.state === 'open') {
      const sectionInfo = targetSectionId ? ` in section "${milestoneName}"` : '';
      console.log(`Creating task for open issue: ${repoFullName}#${issue.number} in project ${projectId}${sectionInfo}`);
      await createTodoistTask(env, {
        title: issue.title,
        issueNumber: issue.number,
        issueUrl: issueUrl,
        projectId: projectId,
        sectionId: targetSectionId,
      });
      return { action: 'created', issue: `${repoFullName}#${issue.number}`, section: milestoneName || null };
    }
    return { action: 'skipped', reason: 'closed_no_task', issue: `${repoFullName}#${issue.number}` };
  }

  // Task exists - sync state
  const taskCompleted = isTaskCompleted(task);

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
  const expectedTitle = `[#${issue.number}] ${issue.title}`;
  let updated = false;

  if (task.content !== expectedTitle) {
    console.log(`Updating task title for issue: ${repoFullName}#${issue.number}`);
    await updateTodoistTask(env, task.id, { content: expectedTitle });
    updated = true;
  }

  // Check if section needs updating (milestone changed)
  const currentSectionId = task.section_id ? String(task.section_id) : null;
  const targetSectionIdStr = targetSectionId ? String(targetSectionId) : null;

  if (currentSectionId !== targetSectionIdStr && sectionCache) {
    const sectionInfo = milestoneName ? ` to section "${milestoneName}"` : ' (removing from section)';
    console.log(`Moving task for issue ${repoFullName}#${issue.number}${sectionInfo}`);
    await updateTodoistTaskSection(env, task.id, targetSectionId);
    return { action: 'section_updated', issue: `${repoFullName}#${issue.number}`, section: milestoneName || null };
  }

  if (updated) {
    return { action: 'updated', issue: `${repoFullName}#${issue.number}` };
  }

  return { action: 'unchanged', issue: `${repoFullName}#${issue.number}` };
}

/**
 * Sync a Todoist task to GitHub
 * Uses project hierarchy to determine org/repo (from _githubOrg and _repoName added during polling)
 * Falls back to parsing GitHub URL from description for tasks created from GitHub
 * Handles section-to-milestone mapping when sectionIdToName and milestoneCache are provided
 */
async function syncTaskToGitHub(env, task, sectionIdToName = null, milestoneCache = null) {
  // First check if task has GitHub URL (was created from GitHub issue)
  const githubInfo = parseGitHubUrl(task.description);

  if (githubInfo) {
    // Task was created from GitHub - sync completion state back
    const issue = await getGitHubIssue(env, githubInfo);
    if (!issue) {
      console.warn(`GitHub issue not found: ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`);
      return { action: 'skipped', reason: 'issue_not_found', taskId: task.id };
    }

    const taskCompleted = isTaskCompleted(task);

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

    // Check if section changed and needs to sync milestone (bidirectional)
    if (sectionIdToName && milestoneCache) {
      const projectIdStr = String(task.project_id);
      const taskSectionId = task.section_id ? String(task.section_id) : null;

      // Get section name from task's section_id
      const projectSectionIdToName = sectionIdToName.get(projectIdStr);
      const taskSectionName = taskSectionId && projectSectionIdToName
        ? projectSectionIdToName.get(taskSectionId)
        : null;

      // Get current milestone from GitHub issue
      const currentMilestoneName = issue.milestone?.title || null;

      // If they differ, update GitHub milestone
      if (taskSectionName !== currentMilestoneName) {
        try {
          // Get milestone number from name (or null to clear)
          const milestoneNumber = taskSectionName
            ? await getMilestoneNumber(env, githubInfo.owner, githubInfo.repo, taskSectionName, milestoneCache)
            : null;

          // Only update if we can find the milestone or we're clearing it
          if (milestoneNumber !== null || taskSectionName === null) {
            console.log(`Updating milestone for issue ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}: "${currentMilestoneName}" → "${taskSectionName}"`);
            await updateGitHubIssueMilestone(env, githubInfo.owner, githubInfo.repo, githubInfo.issueNumber, milestoneNumber);
            return { action: 'milestone_updated', issue: `${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`, milestone: taskSectionName };
          } else if (taskSectionName) {
            console.warn(`Cannot find milestone "${taskSectionName}" in ${githubInfo.owner}/${githubInfo.repo} - skipping milestone update`);
          }
        } catch (error) {
          console.error(`Failed to update milestone for issue ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}:`, error);
          // Continue without updating milestone
        }
      }
    }

    return { action: 'unchanged', taskId: task.id };
  }

  // No GitHub URL - task was created in Todoist, might need to create GitHub issue
  // Use project hierarchy info (added during polling) to determine repo
  if (!task._githubOrg || !task._repoName) {
    return { action: 'skipped', reason: 'no_repo_info', taskId: task.id };
  }

  // Skip completed tasks - don't create closed issues
  if (isTaskCompleted(task)) {
    return { action: 'skipped', reason: 'completed_no_issue', taskId: task.id };
  }

  // Determine milestone from section (if task is in a section)
  let milestoneNumber = null;
  let milestoneName = null;

  if (sectionIdToName && milestoneCache && task.section_id) {
    const projectIdStr = String(task.project_id);
    const taskSectionId = String(task.section_id);
    const projectSectionIdToName = sectionIdToName.get(projectIdStr);

    if (projectSectionIdToName) {
      milestoneName = projectSectionIdToName.get(taskSectionId);
      if (milestoneName) {
        try {
          milestoneNumber = await getMilestoneNumber(env, task._githubOrg, task._repoName, milestoneName, milestoneCache);
          if (!milestoneNumber) {
            console.warn(`Milestone "${milestoneName}" not found in ${task._fullRepo} - creating issue without milestone`);
          }
        } catch (error) {
          console.error(`Failed to get milestone for ${task._fullRepo}:`, error);
          // Continue without milestone
        }
      }
    }
  }

  // Create GitHub issue for this task
  // Strip any existing prefix from the task content before using as issue title
  const issueTitle = stripTodoistPrefix(task.content);
  const milestoneInfo = milestoneNumber ? ` with milestone "${milestoneName}"` : '';
  console.log(`Creating GitHub issue for task: ${task._fullRepo} - ${issueTitle}${milestoneInfo}`);
  try {
    const issue = await createGitHubIssue(env, {
      owner: task._githubOrg,
      repo: task._repoName,
      title: issueTitle,
      body: task.description || `Created from Todoist task: ${task.id}`,
      milestone: milestoneNumber,
    });

    // Update task with GitHub URL and add issue number prefix
    const newTaskContent = `[#${issue.number}] ${issueTitle}`;
    await updateTodoistTask(env, task.id, {
      content: newTaskContent,
      description: issue.html_url,
    });
    console.log(`Created GitHub issue: ${issue.html_url}`);

    return { action: 'created_issue', issue: issue.html_url, taskId: task.id, milestone: milestoneName };
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
 *
 * Milestone/Section sync:
 * - GitHub milestones map to Todoist sections (within sub-projects)
 * - Syncs bidirectionally: milestone changes → section changes, and vice versa
 *
 * Auto-backfill: When new sub-projects are detected, automatically backfills
 * their GitHub issues to Todoist tasks.
 */
async function performBidirectionalSync(env) {
  console.log('Starting bidirectional sync...');
  const startTime = Date.now();

  // Load current sync state
  const state = await loadSyncState(env);
  console.log(`Last sync: ${state.lastPollTime || 'never'}, Poll count: ${state.pollCount}`);

  const results = {
    github: { processed: 0, created: 0, updated: 0, completed: 0, reopened: 0, section_updated: 0, errors: 0 },
    todoist: { processed: 0, closed: 0, reopened: 0, created_issues: 0, milestone_updated: 0, errors: 0 },
    autoBackfill: { newProjects: 0, issues: 0, created: 0, skipped: 0, errors: 0 },
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

    // Pre-fetch sections for all sub-projects (for milestone<->section mapping)
    const currentProjectIds = Array.from(projectHierarchy.subProjects.keys());
    console.log('Fetching sections for milestone mapping...');
    const { sectionCache, sectionIdToName } = await fetchSectionsForProjects(env, currentProjectIds);

    // Initialize milestone cache (populated lazily per-repo)
    const milestoneCache = new Map();

    // Detect new projects for auto-backfill
    // Only auto-backfill if we have known projects (skip on first sync to avoid backfilling everything)
    const knownProjectIds = new Set(state.knownProjectIds || []);
    const hasKnownProjects = state.knownProjectIds !== undefined && state.knownProjectIds.length > 0;
    const newProjectIds = currentProjectIds.filter((id) => !knownProjectIds.has(id));

    // Check for forced backfill (triggered by POST /reset-projects)
    const forceBackfill = state.forceBackfillNextSync === true;
    const forceBackfillProjectIds = state.forceBackfillProjectIds || [];

    // Track projects that still need backfilling (for progressive backfill)
    let incompleteBackfillProjects = [];

    if (forceBackfill && forceBackfillProjectIds.length > 0) {
      // Forced backfill from POST /reset-projects
      console.log(`Forced backfill triggered for ${forceBackfillProjectIds.length} project(s):`, forceBackfillProjectIds);
      results.autoBackfill.newProjects = forceBackfillProjectIds.length;

      incompleteBackfillProjects = await performAutoBackfill(env, forceBackfillProjectIds, projectHierarchy, results.autoBackfill, sectionCache) || [];
    } else if (newProjectIds.length > 0 && hasKnownProjects) {
      // We have a baseline and detected new projects - auto-backfill them
      console.log(`Detected ${newProjectIds.length} new project(s) for auto-backfill:`, newProjectIds);
      results.autoBackfill.newProjects = newProjectIds.length;

      incompleteBackfillProjects = await performAutoBackfill(env, newProjectIds, projectHierarchy, results.autoBackfill, sectionCache) || [];
    } else if (!hasKnownProjects && !forceBackfill) {
      // No baseline yet - record current projects without backfilling
      if (state.pollCount > 0) {
        // Migration: previous syncs existed but didn't track projects (older code version)
        console.log(
          `Recording ${currentProjectIds.length} existing project(s) as baseline (migrating from older sync state). ` +
            `Future new projects will be auto-backfilled. To backfill existing repos now, use POST /backfill`
        );
      } else {
        // True first sync
        console.log(
          `First sync: recording ${currentProjectIds.length} project(s) as baseline. ` +
            `Future new projects will be auto-backfilled. To backfill existing repos, use POST /backfill`
        );
      }
    } else if (newProjectIds.length === 0 && !forceBackfill) {
      console.log(`No new projects detected (tracking ${knownProjectIds.size} project(s))`);
    }

    // Poll GitHub for changes
    console.log(`Polling GitHub for issues updated since: ${state.lastGitHubSync || 'beginning'}`);
    const githubIssues = await pollGitHubChanges(env, state.lastGitHubSync, projectHierarchy);
    console.log(`Found ${githubIssues.length} GitHub issues to process`);

    // Process GitHub -> Todoist sync (with section cache for milestone mapping)
    for (const issue of githubIssues) {
      try {
        const result = await syncIssueToTodoist(env, issue, sectionCache);
        results.github.processed++;
        if (result.action === 'created') results.github.created++;
        else if (result.action === 'updated') results.github.updated++;
        else if (result.action === 'completed') results.github.completed++;
        else if (result.action === 'reopened') results.github.reopened++;
        else if (result.action === 'section_updated') results.github.section_updated++;
      } catch (error) {
        console.error(`Error syncing issue ${issue._repoFullName}#${issue.number}:`, error);
        results.github.errors++;
      }
    }

    // Poll Todoist for changes
    console.log(`Polling Todoist with sync token: ${state.todoistSyncToken === '*' ? 'full sync' : 'incremental'}`);
    const { tasks: todoistTasks, newSyncToken, fullSync } = await pollTodoistChanges(env, state.todoistSyncToken, projectHierarchy);
    console.log(`Found ${todoistTasks.length} Todoist tasks to process (full_sync: ${fullSync})`);

    // Process Todoist -> GitHub sync (with section and milestone caches)
    for (const task of todoistTasks) {
      try {
        const result = await syncTaskToGitHub(env, task, sectionIdToName, milestoneCache);
        results.todoist.processed++;
        if (result.action === 'closed') results.todoist.closed++;
        else if (result.action === 'reopened') results.todoist.reopened++;
        else if (result.action === 'created_issue') results.todoist.created_issues++;
        else if (result.action === 'milestone_updated') results.todoist.milestone_updated++;
      } catch (error) {
        console.error(`Error syncing task ${task.id}:`, error);
        results.todoist.errors++;
      }
    }

    // Save updated sync state (including all known project IDs)
    // Preserve incomplete backfill projects for next sync cycle
    const hasIncompleteBackfill = incompleteBackfillProjects.length > 0;
    const newState = {
      lastGitHubSync: new Date().toISOString(),
      todoistSyncToken: newSyncToken,
      lastPollTime: new Date().toISOString(),
      pollCount: state.pollCount + 1,
      knownProjectIds: currentProjectIds, // Track all current projects
      // Keep force backfill flags if there are incomplete projects
      forceBackfillNextSync: hasIncompleteBackfill,
      forceBackfillProjectIds: incompleteBackfillProjects,
    };
    await saveSyncState(env, newState);

    if (hasIncompleteBackfill) {
      console.log(`${incompleteBackfillProjects.length} project(s) will continue backfilling on next sync`);
    }

    const duration = Date.now() - startTime;
    console.log(`Sync completed in ${duration}ms:`, JSON.stringify(results));

    return { success: true, duration, results };
  } catch (error) {
    console.error('Sync failed:', error);
    return { success: false, error: error.message, results };
  }
}

/**
 * Auto-backfill newly detected projects
 * Called during scheduled sync when new Todoist sub-projects are found
 * Includes milestone-to-section mapping when sectionCache is provided
 *
 * Uses batched API calls to minimize subrequest count:
 * 1. Fetch all issues first (GitHub API calls are unavoidable per-repo)
 * 2. Batch create all needed sections in one Sync API call
 * 3. Batch create all tasks in one Sync API call
 *
 * Respects MAX_TASKS_PER_SYNC limit to prevent hitting Cloudflare limits
 *
 * @returns {Array} - List of project IDs that still need more backfilling (hit the limit)
 */
async function performAutoBackfill(env, newProjectIds, projectHierarchy, results, sectionCache = null) {
  const { subProjects } = projectHierarchy;

  // Get repos to backfill
  const reposToBackfill = newProjectIds
    .filter((id) => subProjects.has(id))
    .map((id) => {
      const project = subProjects.get(id);
      return {
        owner: project.githubOrg,
        name: project.repoName,
        projectId: project.id,
        fullRepo: project.fullRepo,
      };
    });

  if (reposToBackfill.length === 0) {
    console.log('No new repos to backfill');
    return [];
  }

  console.log(`Auto-backfilling ${reposToBackfill.length} new repo(s):`, reposToBackfill.map((r) => r.fullRepo));

  // Pre-fetch existing tasks for the new projects (batch operation - 1 API call)
  const existingTasks = await fetchExistingTasksForProjects(
    env,
    reposToBackfill.map((r) => r.projectId)
  );

  console.log(`Found ${existingTasks.size} existing tasks with GitHub URLs across ${reposToBackfill.length} projects`);

  // Phase 1: Collect all issues to backfill (respecting per-sync limit)
  const tasksToCreate = [];
  const sectionsNeeded = new Map(); // "projectId:milestoneName" -> { projectId, name }
  const incompleteProjects = new Set(); // Projects that still have more issues to backfill
  let hitLimit = false;

  for (const repo of reposToBackfill) {
    try {
      console.log(`Scanning issues for: ${repo.fullRepo}`);
      let repoHasMoreIssues = false;

      // Fetch open issues for this repo
      for await (const issue of fetchGitHubIssues(env, repo.owner, repo.name, { state: 'open' })) {
        results.issues++;

        // Check if task already exists (using pre-fetched map)
        if (existingTasks.has(issue.html_url)) {
          results.skipped++;
          continue;
        }

        // Check per-sync limit
        if (tasksToCreate.length >= CONSTANTS.MAX_TASKS_PER_SYNC) {
          console.log(`Reached per-sync limit of ${CONSTANTS.MAX_TASKS_PER_SYNC} tasks, will continue on next sync`);
          hitLimit = true;
          repoHasMoreIssues = true;
          break;
        }

        // Determine section from milestone (if available)
        let sectionId = null;
        const milestoneName = issue.milestone?.title;

        if (milestoneName && sectionCache) {
          // Check if section already exists in cache
          const projectSections = sectionCache.get(String(repo.projectId));
          if (projectSections?.has(milestoneName)) {
            sectionId = projectSections.get(milestoneName);
          } else {
            // Mark this section as needed for batch creation
            const sectionKey = `${repo.projectId}:${milestoneName}`;
            if (!sectionsNeeded.has(sectionKey)) {
              sectionsNeeded.set(sectionKey, {
                projectId: repo.projectId,
                name: milestoneName,
              });
            }
          }
        }

        tasksToCreate.push({
          title: issue.title,
          issueNumber: issue.number,
          issueUrl: issue.html_url,
          projectId: repo.projectId,
          milestoneName: milestoneName,
          sectionId: sectionId,
          fullRepo: repo.fullRepo,
        });
      }

      // Track if this repo needs more backfilling
      if (repoHasMoreIssues) {
        incompleteProjects.add(repo.projectId);
      }

      // Break outer loop if limit reached
      if (hitLimit) {
        // Add all remaining repos to incomplete list
        const currentIdx = reposToBackfill.findIndex(r => r.projectId === repo.projectId);
        for (let i = currentIdx + 1; i < reposToBackfill.length; i++) {
          incompleteProjects.add(reposToBackfill[i].projectId);
        }
        break;
      }
    } catch (error) {
      console.error(`Failed to fetch issues for repo ${repo.fullRepo}:`, error);
      results.errors++;
      // Mark as incomplete so we retry next sync
      incompleteProjects.add(repo.projectId);
    }
  }

  if (tasksToCreate.length === 0) {
    console.log('No new tasks to create');
    return Array.from(incompleteProjects);
  }

  console.log(`Collected ${tasksToCreate.length} task(s) to create, ${sectionsNeeded.size} section(s) to create`);

  // Phase 2: Batch create needed sections (1 API call)
  if (sectionsNeeded.size > 0) {
    // Limit sections to prevent too many in one sync
    const sectionsToCreate = Array.from(sectionsNeeded.values()).slice(0, CONSTANTS.MAX_SECTIONS_PER_SYNC);

    if (sectionsToCreate.length > 0) {
      console.log(`Batch creating ${sectionsToCreate.length} section(s)...`);
      const createdSections = await batchCreateSections(env, sectionsToCreate);

      // Update section cache and task references
      for (const [key, sectionId] of createdSections.entries()) {
        const [projectId, sectionName] = key.split(':');

        // Update cache
        if (!sectionCache.has(projectId)) {
          sectionCache.set(projectId, new Map());
        }
        sectionCache.get(projectId).set(sectionName, sectionId);
      }

      // Update tasks with newly created section IDs
      for (const task of tasksToCreate) {
        if (task.milestoneName && !task.sectionId) {
          const sectionKey = `${task.projectId}:${task.milestoneName}`;
          const newSectionId = createdSections.get(sectionKey);
          if (newSectionId) {
            task.sectionId = newSectionId;
          } else {
            // Check if it was added to cache by another means
            const projectSections = sectionCache.get(String(task.projectId));
            if (projectSections?.has(task.milestoneName)) {
              task.sectionId = projectSections.get(task.milestoneName);
            }
          }
        }
      }
    }
  }

  // Phase 3: Batch create all tasks (1-2 API calls depending on batch size)
  console.log(`Batch creating ${tasksToCreate.length} task(s)...`);
  const batchResults = await batchCreateTodoistTasks(env, tasksToCreate);

  results.created = batchResults.success;
  results.errors += batchResults.failed;

  // Log what was created
  for (const task of tasksToCreate.slice(0, batchResults.success)) {
    const sectionInfo = task.milestoneName ? ` (section: ${task.milestoneName})` : '';
    console.log(`Created task for: ${task.fullRepo}#${task.issueNumber}${sectionInfo}`);
  }

  if (batchResults.errors.length > 0) {
    console.log(`Batch creation had ${batchResults.errors.length} error(s):`, JSON.stringify(batchResults.errors));
  }

  const incompleteList = Array.from(incompleteProjects);
  if (incompleteList.length > 0) {
    console.log(`Auto-backfill incomplete, ${incompleteList.length} project(s) need more backfilling on next sync`);
  }

  console.log('Auto-backfill completed:', JSON.stringify(results));
  return incompleteList;
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
      pollingIntervalMinutes: CONSTANTS.POLLING_INTERVAL_MINUTES,
    };

    // Mark as unhealthy if last poll was more than threshold
    if (timeSinceLastPoll !== null && timeSinceLastPoll > CONSTANTS.DEGRADED_THRESHOLD_MINUTES) {
      status.status = 'degraded';
      status.warning = `Last sync was more than ${CONSTANTS.DEGRADED_THRESHOLD_MINUTES} minutes ago`;
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

/**
 * Handle POST /reset-projects request
 * Resets known projects to trigger auto-backfill on next sync
 */
async function handleResetProjects(request, env) {
  // Authenticate using same auth as backfill
  if (!verifyBackfillAuth(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Parse request body (optional)
  let body = {};
  try {
    const text = await request.text();
    if (text) {
      body = JSON.parse(text);
    }
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { mode = 'all', projectIds = [], dryRun = false } = body;

  // Validate mode
  if (!['all', 'specific'].includes(mode)) {
    return jsonResponse({ error: 'mode must be "all" or "specific"' }, 400);
  }

  // Validate projectIds for specific mode
  if (mode === 'specific') {
    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      return jsonResponse({ error: 'projectIds array is required for "specific" mode' }, 400);
    }
    if (!projectIds.every(id => typeof id === 'string')) {
      return jsonResponse({ error: 'projectIds must be an array of strings' }, 400);
    }
  }

  try {
    // Load current sync state
    const state = await loadSyncState(env);
    const currentKnownProjects = state.knownProjectIds || [];

    // Fetch current Todoist project hierarchy to show what will be backfilled
    const orgMappings = parseOrgMappings(env);
    const projects = await fetchTodoistProjects(env);
    const hierarchy = buildProjectHierarchy(projects, orgMappings);
    const currentProjectIds = Array.from(hierarchy.subProjects.keys());

    let resetProjectIds;
    let remainingKnownProjects;

    if (mode === 'all') {
      // Reset all - use sentinel to trigger backfill for all projects
      resetProjectIds = currentProjectIds;
      remainingKnownProjects = [];
    } else {
      // Specific mode - only reset specified projects
      const projectIdsSet = new Set(projectIds.map(String));
      resetProjectIds = currentProjectIds.filter(id => projectIdsSet.has(id));
      remainingKnownProjects = currentKnownProjects.filter(id => !projectIdsSet.has(String(id)));
    }

    // Build response with project details
    const projectDetails = resetProjectIds.map(id => {
      const project = hierarchy.subProjects.get(id);
      return {
        id,
        name: project?.name || 'unknown',
        repo: project?.fullRepo || 'unknown',
      };
    });

    if (dryRun) {
      return jsonResponse({
        success: true,
        dryRun: true,
        message: `Would reset ${resetProjectIds.length} project(s) for backfill on next sync`,
        resetProjects: projectDetails,
        remainingKnownProjects: remainingKnownProjects,
        currentKnownProjects: currentKnownProjects.length,
      });
    }

    // Actually reset the state
    // Set knownProjectIds to only contain projects we DON'T want to backfill
    // Also set forceBackfillNextSync flag to ensure backfill happens even if knownProjectIds is empty
    const newState = {
      ...state,
      knownProjectIds: remainingKnownProjects,
      forceBackfillNextSync: true, // Flag to trigger backfill on next sync
      forceBackfillProjectIds: resetProjectIds, // Projects to backfill
    };

    await saveSyncState(env, newState);

    console.log(`Reset ${resetProjectIds.length} project(s) for auto-backfill. Remaining known: ${remainingKnownProjects.length}`);

    return jsonResponse({
      success: true,
      message: `Reset ${resetProjectIds.length} project(s). They will be auto-backfilled on the next sync.`,
      resetProjects: projectDetails,
      remainingKnownProjects: remainingKnownProjects,
      nextSyncWillBackfill: resetProjectIds.length,
    });
  } catch (error) {
    console.error('Failed to reset projects:', error);
    return jsonResponse({ error: error.message }, 500);
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
    if (request.method === 'POST' && url.pathname === '/reset-projects') {
      return handleResetProjects(request, env);
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
  async scheduled(_controller, env, _ctx) {
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
  { title, issueNumber, issueUrl, projectId, sectionId = null }
) {
  if (!projectId) {
    throw new Error('projectId is required - ensure ORG_MAPPINGS is configured');
  }

  const taskData = {
    content: `[#${issueNumber}] ${title}`,
    description: issueUrl,
    project_id: projectId,
  };

  // Add section if milestone-based section is specified
  if (sectionId) {
    taskData.section_id = sectionId;
  }

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
 * Batch create multiple Todoist tasks using the Sync API
 * This significantly reduces API calls by sending multiple commands in one request
 *
 * @param {Object} env - Environment with TODOIST_API_TOKEN
 * @param {Array} tasks - Array of task objects: { title, issueNumber, issueUrl, projectId, sectionId }
 * @returns {Object} - { success: number, failed: number, errors: Array }
 */
async function batchCreateTodoistTasks(env, tasks) {
  if (tasks.length === 0) {
    return { success: 0, failed: 0, errors: [] };
  }

  const results = { success: 0, failed: 0, errors: [] };

  // Process in batches to avoid hitting any single-request limits
  const batchSize = CONSTANTS.BATCH_TASK_LIMIT;

  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);

    // Build Sync API commands for this batch
    const commands = batch.map((task, idx) => ({
      type: 'item_add',
      temp_id: `temp_${i + idx}_${Date.now()}`,
      uuid: crypto.randomUUID(),
      args: {
        content: `[#${task.issueNumber}] ${task.title}`,
        description: task.issueUrl,
        project_id: task.projectId,
        ...(task.sectionId && { section_id: task.sectionId }),
      },
    }));

    try {
      const response = await fetch('https://api.todoist.com/sync/v9/sync', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ commands }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      // Check sync_status for individual command results
      if (data.sync_status) {
        for (const [uuid, status] of Object.entries(data.sync_status)) {
          if (status === 'ok') {
            results.success++;
          } else {
            results.failed++;
            results.errors.push({ uuid, status });
          }
        }
      } else {
        // If no sync_status, assume all succeeded
        results.success += batch.length;
      }
    } catch (error) {
      console.error(`Batch task creation failed:`, error);
      results.failed += batch.length;
      results.errors.push({ batch: i, error: error.message });
    }
  }

  return results;
}

/**
 * Batch create multiple sections using the Sync API
 * Returns a map of sectionName -> sectionId for created sections
 *
 * @param {Object} env - Environment with TODOIST_API_TOKEN
 * @param {Array} sections - Array of { projectId, name }
 * @returns {Map} - Map of "projectId:name" -> sectionId
 */
async function batchCreateSections(env, sections) {
  const createdSections = new Map();

  if (sections.length === 0) {
    return createdSections;
  }

  // Build Sync API commands
  const commands = sections.map((section, idx) => ({
    type: 'section_add',
    temp_id: `section_temp_${idx}_${Date.now()}`,
    uuid: crypto.randomUUID(),
    args: {
      name: section.name,
      project_id: section.projectId,
    },
  }));

  try {
    const response = await fetch('https://api.todoist.com/sync/v9/sync', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ commands }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    // Map temp_ids to real IDs from the response
    if (data.temp_id_mapping) {
      for (let i = 0; i < sections.length; i++) {
        const tempId = `section_temp_${i}_${Date.now()}`;
        // The temp_id_mapping maps temp_id -> real_id
        // We need to find our section in the mapping
        for (const [tid, realId] of Object.entries(data.temp_id_mapping)) {
          if (tid.startsWith(`section_temp_${i}_`)) {
            const key = `${sections[i].projectId}:${sections[i].name}`;
            createdSections.set(key, realId);
            break;
          }
        }
      }
    }

    // Also update from sections in the response if available
    if (data.sections) {
      for (const section of data.sections) {
        const key = `${section.project_id}:${section.name}`;
        createdSections.set(key, section.id);
      }
    }

    console.log(`Batch created ${sections.length} section(s)`);
  } catch (error) {
    console.error(`Batch section creation failed:`, error);
  }

  return createdSections;
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
 * Searches all tasks using Todoist's search filter
 */
async function findTodoistTaskByIssueUrl(env, issueUrl) {
  return withRetry(async () => {
    // Use global search filter to find the task by URL
    const filterQuery = encodeURIComponent(`search: ${issueUrl}`);
    const response = await fetch(
      `https://api.todoist.com/rest/v2/tasks?filter=${filterQuery}`,
      {
        headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
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

/**
 * Strip the [#issue] prefix from Todoist task content
 * Used when creating GitHub issues from Todoist tasks
 */
function stripTodoistPrefix(content) {
  if (!content) return content;
  // Match: [#123] at the start (new format)
  // Also matches legacy [repo-name#123] or [owner/repo#123] for backwards compatibility
  return content.replace(/^\[[\w./-]*#\d+\]\s*/, '');
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
 * milestone is the milestone number (not title)
 */
async function createGitHubIssue(env, { owner, repo, title, body, milestone = null }) {
  return withRetry(async () => {
    const issueData = { title, body };

    // Add milestone if specified
    if (milestone !== null) {
      issueData.milestone = milestone;
    }

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
        body: JSON.stringify(issueData),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  });
}

// =============================================================================
// Backfill Handler
// =============================================================================

/**
 * Fetch all tasks for specified projects using Todoist Sync API
 * Returns a Map of issueUrl -> taskId for quick existence checking
 * This is much more efficient than checking each issue individually
 */
async function fetchExistingTasksForProjects(env, projectIds) {
  const existingTasks = new Map(); // issueUrl -> { taskId, projectId }

  // Use Sync API to get all tasks at once (much more efficient than REST API per-task)
  const response = await fetch('https://api.todoist.com/sync/v9/sync', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      sync_token: '*', // Full sync to get all tasks
      resource_types: '["items"]',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const projectIdSet = new Set(projectIds.map(String));

  // Filter to tasks in our target projects and extract GitHub URLs
  for (const task of data.items || []) {
    const taskProjectId = String(task.project_id);
    if (!projectIdSet.has(taskProjectId)) continue;

    // Check if task has a GitHub issue URL in description
    if (task.description) {
      const githubUrlMatch = task.description.match(
        /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/
      );
      if (githubUrlMatch) {
        existingTasks.set(githubUrlMatch[0], {
          taskId: task.id,
          projectId: taskProjectId,
        });
      }
    }
  }

  console.log(`Found ${existingTasks.size} existing tasks with GitHub URLs across ${projectIds.length} projects`);
  return existingTasks;
}

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
 */
function verifyBackfillAuth(request, env) {
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
 * Validate backfill request body
 */
function validateBackfillRequest(body, env) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const { mode, repo, owner, state = 'open', dryRun = false, limit } = body;

  // Validate mode
  if (!mode || !['single-repo', 'org', 'projects'].includes(mode)) {
    return { valid: false, error: 'mode must be "single-repo", "org", or "projects"' };
  }

  // Validate repo for single-repo mode
  if (mode === 'single-repo' && !repo) {
    return { valid: false, error: 'repo is required for single-repo mode' };
  }

  // For "projects" mode, owner is not required (uses ORG_MAPPINGS)
  // For other modes, owner is required
  if (mode !== 'projects' && !owner) {
    return { valid: false, error: 'owner is required for single-repo and org modes' };
  }

  // For "projects" mode, ORG_MAPPINGS is required
  if (mode === 'projects' && !env.ORG_MAPPINGS) {
    return { valid: false, error: 'ORG_MAPPINGS env var is required for "projects" mode' };
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
      owner,
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
      per_page: String(Math.min(CONSTANTS.PER_PAGE, limit - fetched)),
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
    if (issues.length < CONSTANTS.PER_PAGE) break;
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
      per_page: String(CONSTANTS.PER_PAGE),
      page: String(page),
      sort: 'name',
    });

    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/orgs/${org}/repos?${params}`,
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

    if (repos.length < CONSTANTS.PER_PAGE) break;
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
      per_page: String(CONSTANTS.PER_PAGE),
      page: String(page),
      sort: 'name',
    });

    const response = await fetch(
      `${CONSTANTS.GITHUB_API_BASE}/users/${user}/repos?${params}`,
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

    if (repos.length < CONSTANTS.PER_PAGE) break;
    page++;
  }
}

/**
 * Process a single issue for backfill
 * @param {Object} env - Environment variables
 * @param {Object} issue - GitHub issue object
 * @param {string} repoFullName - Full repo name (owner/repo)
 * @param {boolean} dryRun - If true, don't actually create tasks
 * @param {string} [projectId] - Optional Todoist project ID for the task
 * @param {Map} [existingTasks] - Pre-fetched map of issueUrl -> taskInfo for batch checking
 * @param {Map} [sectionCache] - Optional section cache for milestone-to-section mapping
 */
async function processBackfillIssue(env, issue, repoFullName, dryRun, projectId = null, existingTasks = null, sectionCache = null) {
  try {
    // Check existence using pre-fetched map (no API call) or fallback to individual check
    let exists;
    if (existingTasks) {
      exists = existingTasks.has(issue.html_url);
    } else {
      exists = await taskExistsForIssue(env, issue.html_url);
    }

    if (exists) {
      return { status: 'skipped', reason: 'already_exists' };
    }

    if (dryRun) {
      const milestone = issue.milestone?.title || null;
      return { status: 'would_create', milestone };
    }

    // For actual task creation, projectId is required (use 'projects' mode)
    if (!projectId) {
      return { status: 'failed', error: 'projectId required - use "projects" mode for task creation' };
    }

    // Determine section from milestone (if available)
    let sectionId = null;
    const milestoneName = issue.milestone?.title;
    if (milestoneName && sectionCache) {
      try {
        sectionId = await getOrCreateSection(env, projectId, milestoneName, sectionCache);
      } catch (error) {
        console.error(`Failed to get/create section for milestone "${milestoneName}":`, error);
        // Continue without section
      }
    }

    const task = await createTodoistTask(env, {
      title: issue.title,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      projectId: projectId,
      sectionId: sectionId,
    });

    return { status: 'created', taskId: task.id, section: milestoneName || null };
  } catch (error) {
    console.error(`Failed to process issue ${repoFullName}#${issue.number}:`, error);
    return { status: 'failed', error: error.message };
  }
}

/**
 * Main backfill handler
 * Supports streaming NDJSON response for real-time progress
 */
async function handleBackfill(request, env, _ctx) {
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
    const githubLimiter = new RateLimiter(CONSTANTS.GITHUB_RATE_LIMIT);
    const todoistLimiter = new RateLimiter(CONSTANTS.TODOIST_RATE_LIMIT);

    try {
      // Get list of repos to process (with optional projectId for task creation)
      let repos;
      let existingTasks = null; // Pre-fetched tasks for batch existence checking
      let sectionCache = null; // Section cache for milestone-to-section mapping

      if (mode === 'single-repo') {
        repos = [{ owner, name: repo, projectId: null }];
      } else if (mode === 'projects') {
        // Use Todoist project hierarchy to determine repos
        const orgMappings = parseOrgMappings(env);
        const projects = await fetchTodoistProjects(env);
        const hierarchy = buildProjectHierarchy(projects, orgMappings);

        repos = Array.from(hierarchy.subProjects.values()).map((p) => ({
          owner: p.githubOrg,
          name: p.repoName,
          projectId: p.id,
        }));

        // Pre-fetch all existing tasks for batch existence checking (1 API call instead of N)
        const projectIds = repos.map((r) => r.projectId);
        existingTasks = await fetchExistingTasksForProjects(env, projectIds);

        // Pre-fetch sections for milestone-to-section mapping
        const sectionResult = await fetchSectionsForProjects(env, projectIds);
        sectionCache = sectionResult.sectionCache;

        await writeJSON({
          type: 'config',
          mode: 'projects',
          orgs: Array.from(orgMappings.values()),
          repos: repos.map((r) => `${r.owner}/${r.name}`),
          existingTaskCount: existingTasks.size,
          sectionCount: Array.from(sectionCache.values()).reduce((sum, m) => sum + m.size, 0),
        });
      } else {
        // mode === 'org': Collect repos from async generator
        repos = [];
        for await (const r of fetchOrgRepos(env, owner)) {
          repos.push({ ...r, projectId: null });
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

            if (!dryRun && !existingTasks) {
              // Only rate limit Todoist calls if we're making individual existence checks
              await todoistLimiter.waitForToken();
            }

            const result = await processBackfillIssue(
              env,
              issue,
              repoFullName,
              dryRun,
              repoInfo.projectId,
              existingTasks, // Pass pre-fetched tasks for batch checking
              sectionCache // Pass section cache for milestone-to-section mapping
            );

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
              projectId: repoInfo.projectId,
              ...result,
            });
          }

          await writeJSON({
            type: 'repo_complete',
            repo: repoFullName,
            issues: repoIssueCount,
            projectId: repoInfo.projectId,
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
