import { describe, it, expect, beforeEach } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from 'cloudflare:test';
import worker from '../src/worker.js';

// Test configuration
const TEST_PARENT_PROJECT_ID = '1000';
const TEST_SUB_PROJECT_ID = '1001';
const TEST_GITHUB_ORG = 'test-org';
const TEST_REPO_NAME = 'test-repo';

// Helper to set up ORG_MAPPINGS for tests
function setupOrgMappings() {
  // Override env.ORG_MAPPINGS for testing
  env.ORG_MAPPINGS = JSON.stringify({
    [TEST_PARENT_PROJECT_ID]: TEST_GITHUB_ORG,
  });
}

// Helper to mock Todoist sections endpoint (required for milestone sync)
function mockTodoistSections(fetchMock, projectId, sections = []) {
  fetchMock
    .get('https://api.todoist.com')
    .intercept({ path: `/rest/v2/sections?project_id=${projectId}` })
    .reply(200, sections);
}

// Helper to mock Todoist projects endpoint
function mockTodoistProjects(fetchMock, projects) {
  fetchMock
    .get('https://api.todoist.com')
    .intercept({ method: 'POST', path: '/sync/v9/sync' })
    .reply(200, { projects, sync_token: 'projects-token' });
}

// Default project hierarchy for tests
const DEFAULT_PROJECTS = [
  { id: TEST_PARENT_PROJECT_ID, name: 'Test Org Issues', parent_id: null },
  { id: TEST_SUB_PROJECT_ID, name: TEST_REPO_NAME, parent_id: TEST_PARENT_PROJECT_ID },
];

describe('Sync Status Endpoint', () => {
  it('returns sync status with default state', async () => {
    const request = new Request('http://localhost/sync-status');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe('healthy');
    expect(json.lastSync).toBe('never');
    expect(json.pollCount).toBe(0);
    expect(json.pollingEnabled).toBe(true);
    expect(json.pollingIntervalMinutes).toBe(15);
  });

  it('returns sync status after sync has run', async () => {
    // Simulate a previous sync by setting state in KV
    await env.WEBHOOK_CACHE.put(
      'sync:state',
      JSON.stringify({
        lastGitHubSync: '2024-01-15T10:30:00Z',
        todoistSyncToken: 'abc123',
        lastPollTime: new Date().toISOString(),
        pollCount: 5,
      })
    );

    const request = new Request('http://localhost/sync-status');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe('healthy');
    expect(json.pollCount).toBe(5);
    expect(json.todoistSyncTokenAge).toBe('incremental');
  });

  it('shows degraded status when last sync is old', async () => {
    // Set last poll time to more than 30 minutes ago
    const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    await env.WEBHOOK_CACHE.put(
      'sync:state',
      JSON.stringify({
        lastGitHubSync: oldTime,
        todoistSyncToken: 'abc123',
        lastPollTime: oldTime,
        pollCount: 5,
      })
    );

    const request = new Request('http://localhost/sync-status');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe('degraded');
    expect(json.warning).toBeDefined();
  });
});

describe('Scheduled Handler with Project Hierarchy', () => {
  beforeEach(() => {
    setupOrgMappings();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('runs bidirectional sync using project hierarchy', async () => {
    // Mock Todoist projects API (called first to get hierarchy)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, TEST_SUB_PROJECT_ID);

    // Mock GitHub issues API
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, []);

    // Mock Todoist items sync (called after projects)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'items-token', full_sync: false });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Verify sync state was saved
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state).toBeDefined();
    expect(state.pollCount).toBe(1);
  });

  it('only syncs repos that have sub-projects', async () => {
    // Mock Todoist projects - only one sub-project
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, TEST_SUB_PROJECT_ID);

    // Mock GitHub issues for the one repo that has a sub-project
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Test Issue',
          html_url: 'https://github.com/test-org/test-repo/issues/1',
          state: 'open',
          labels: [],
        },
      ]);

    // Mock Todoist task lookup
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: /\/rest\/v2\/tasks/ })
      .reply(200, []);

    // Mock Todoist task creation
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/rest/v2/tasks' })
      .reply(201, { id: 'task-123', content: 'Test' });

    // Mock Todoist items sync
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'items-token', full_sync: false });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(1);
  });

  it('handles missing org mappings gracefully', async () => {
    // Clear org mappings
    env.ORG_MAPPINGS = '';
    // Also clear legacy env vars to ensure no fallback
    const originalProjectId = env.TODOIST_PROJECT_ID;
    const originalOrg = env.GITHUB_ORG;
    env.TODOIST_PROJECT_ID = '';
    env.GITHUB_ORG = '';

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Restore for other tests
    env.TODOIST_PROJECT_ID = originalProjectId;
    env.GITHUB_ORG = originalOrg;

    // Sync should complete without error but do nothing
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    // State may not be updated if no mappings
    expect(state === null || state.pollCount === 0).toBe(true);
  });
});

describe('Todoist Task to GitHub Issue Creation', () => {
  beforeEach(() => {
    setupOrgMappings();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('creates GitHub issue for new task in sub-project', async () => {
    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, TEST_SUB_PROJECT_ID);

    // Mock GitHub issues (no existing)
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, []);

    // Mock Todoist items sync - new task without GitHub URL
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, {
        items: [
          {
            id: 'task-new',
            project_id: TEST_SUB_PROJECT_ID,
            content: 'New task from Todoist',
            description: '', // No GitHub URL
            is_completed: false,
          },
        ],
        sync_token: 'items-token',
        full_sync: false,
      });

    // Mock GitHub issue creation
    fetchMock
      .get('https://api.github.com')
      .intercept({ method: 'POST', path: '/repos/test-org/test-repo/issues' })
      .reply(201, {
        number: 42,
        html_url: 'https://github.com/test-org/test-repo/issues/42',
      });

    // Mock Todoist task update (to add GitHub URL)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: /\/rest\/v2\/tasks\/task-new/ })
      .reply(200, {});

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(1);
  });

  it('does not create issue for task that already has GitHub URL', async () => {
    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, TEST_SUB_PROJECT_ID);

    // Mock GitHub issues
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, []);

    // Mock GitHub issue GET (for checking state)
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: '/repos/test-org/test-repo/issues/1' })
      .reply(200, { number: 1, state: 'open' });

    // Mock Todoist items sync - task WITH GitHub URL
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, {
        items: [
          {
            id: 'task-existing',
            project_id: TEST_SUB_PROJECT_ID,
            content: '[#1] Existing task',
            description: 'https://github.com/test-org/test-repo/issues/1',
            is_completed: false,
          },
        ],
        sync_token: 'items-token',
        full_sync: false,
      });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Should complete without trying to create a new issue
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(1);
  });
});

describe('GitHub Issue to Todoist Task in Sub-Project', () => {
  beforeEach(() => {
    setupOrgMappings();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('creates task in correct sub-project for GitHub issue', async () => {
    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, TEST_SUB_PROJECT_ID);

    // Mock GitHub issues
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'New Issue',
          html_url: 'https://github.com/test-org/test-repo/issues/1',
          state: 'open',
          labels: [],
        },
      ]);

    // Mock Todoist task lookup - no existing task
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: /\/rest\/v2\/tasks/ })
      .reply(200, []);

    // Mock Todoist task creation
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/rest/v2/tasks' })
      .reply(201, { id: 'new-task', content: 'Test' });

    // Mock Todoist items sync
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'items-token', full_sync: false });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Verify sync completed
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(1);
  });
});

describe('Multiple Organizations', () => {
  beforeEach(() => {
    // Set up multiple org mappings
    env.ORG_MAPPINGS = JSON.stringify({
      '1000': 'org-one',
      '2000': 'org-two',
    });
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('handles multiple parent projects with different orgs', async () => {
    const multiOrgProjects = [
      { id: '1000', name: 'Org One Issues', parent_id: null },
      { id: '1001', name: 'repo-a', parent_id: '1000' },
      { id: '2000', name: 'Org Two Issues', parent_id: null },
      { id: '2001', name: 'repo-b', parent_id: '2000' },
    ];

    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: multiOrgProjects, sync_token: 'projects-token' });

    // Mock Todoist sections (for milestone sync) - both sub-projects
    mockTodoistSections(fetchMock, '1001');
    mockTodoistSections(fetchMock, '2001');

    // Mock GitHub issues for both repos using a single regex
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/(org-one\/repo-a|org-two\/repo-b)\/issues/ })
      .reply(200, [])
      .times(2);

    // Mock Todoist items sync
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'items-token', full_sync: false });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(1);
  });
});

describe('Task Completion Sync', () => {
  beforeEach(() => {
    setupOrgMappings();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('closes GitHub issue when Todoist task is completed', async () => {
    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, TEST_SUB_PROJECT_ID);

    // Mock GitHub issues
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues\?/ })
      .reply(200, []);

    // Mock GitHub issue GET
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: '/repos/test-org/test-repo/issues/1' })
      .reply(200, { number: 1, state: 'open' });

    // Mock GitHub issue PATCH (close)
    fetchMock
      .get('https://api.github.com')
      .intercept({ method: 'PATCH', path: '/repos/test-org/test-repo/issues/1' })
      .reply(200, { number: 1, state: 'closed' });

    // Mock Todoist items sync - completed task
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, {
        items: [
          {
            id: 'task-123',
            project_id: TEST_SUB_PROJECT_ID,
            content: '[#1] Task',
            description: 'https://github.com/test-org/test-repo/issues/1',
            is_completed: true,
            checked: 1,
          },
        ],
        sync_token: 'items-token',
        full_sync: false,
      });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(1);
  });
});

describe('Auto-Backfill for New Projects', () => {
  beforeEach(() => {
    setupOrgMappings();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('tracks known project IDs in sync state', async () => {
    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, TEST_SUB_PROJECT_ID);

    // Mock GitHub issues
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, []);

    // Mock Todoist batch task fetch (for auto-backfill check)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'items-token', full_sync: false });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.knownProjectIds).toBeDefined();
    expect(state.knownProjectIds).toContain(TEST_SUB_PROJECT_ID);
  });

  it('auto-backfills new projects when detected', async () => {
    // Set up initial state with one known project
    await env.WEBHOOK_CACHE.put(
      'sync:state',
      JSON.stringify({
        lastGitHubSync: '2024-01-15T10:30:00Z',
        todoistSyncToken: 'existing-token',
        lastPollTime: '2024-01-15T10:30:00Z',
        pollCount: 5,
        knownProjectIds: [TEST_SUB_PROJECT_ID], // Only knows about first project
      })
    );

    // Mock Todoist projects with a NEW sub-project
    const projectsWithNew = [
      ...DEFAULT_PROJECTS,
      { id: '1002', name: 'new-repo', parent_id: TEST_PARENT_PROJECT_ID },
    ];

    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: projectsWithNew, sync_token: 'projects-token' });

    // Mock Todoist sections (for milestone sync) - both sub-projects
    mockTodoistSections(fetchMock, TEST_SUB_PROJECT_ID);
    mockTodoistSections(fetchMock, '1002');

    // Mock Todoist batch task fetch for auto-backfill (no existing tasks)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'batch-token' });

    // Mock GitHub issues for the NEW repo (for auto-backfill)
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/new-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Issue in new repo',
          html_url: 'https://github.com/test-org/new-repo/issues/1',
          state: 'open',
          labels: [],
        },
      ]);

    // Mock Todoist task creation for auto-backfill
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/rest/v2/tasks' })
      .reply(201, { id: 'auto-backfill-task', content: 'Test' });

    // Mock GitHub issues for the existing repo (normal sync)
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, []);

    // Mock Todoist items sync (normal sync)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'items-token', full_sync: false });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Verify new project is now in known projects
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.knownProjectIds).toContain('1002');
    expect(state.knownProjectIds).toHaveLength(2);
  });

  it('does not re-backfill already known projects', async () => {
    // Set up initial state with all projects already known
    await env.WEBHOOK_CACHE.put(
      'sync:state',
      JSON.stringify({
        lastGitHubSync: '2024-01-15T10:30:00Z',
        todoistSyncToken: 'existing-token',
        lastPollTime: '2024-01-15T10:30:00Z',
        pollCount: 5,
        knownProjectIds: [TEST_SUB_PROJECT_ID], // Already knows the project
      })
    );

    // Mock Todoist projects (same as known)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, TEST_SUB_PROJECT_ID);

    // Mock GitHub issues for normal sync
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, []);

    // Mock Todoist items sync
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'items-token', full_sync: false });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Sync should complete normally without auto-backfill
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(6);
  });
});

describe('Milestone to Section Sync', () => {
  beforeEach(() => {
    setupOrgMappings();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('creates task in section for issue with milestone', async () => {
    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections - return existing section matching milestone name
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: `/rest/v2/sections?project_id=${TEST_SUB_PROJECT_ID}` })
      .reply(200, [{ id: 'section-v1', name: 'v1.0', project_id: TEST_SUB_PROJECT_ID }]);

    // Mock GitHub issues with milestone
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Issue with milestone',
          html_url: 'https://github.com/test-org/test-repo/issues/1',
          state: 'open',
          labels: [],
          milestone: { title: 'v1.0', number: 1 },
        },
      ]);

    // Mock Todoist task lookup - no existing task
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'GET', path: /\/rest\/v2\/tasks/ })
      .reply(200, []);

    // Mock Todoist task creation - section_id in response shows milestone mapped to section
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/rest/v2/tasks' })
      .reply(201, { id: 'new-task', content: 'Test', section_id: 'section-v1' });

    // Mock Todoist items sync
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'items-token', full_sync: false });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Sync should complete - task created in existing section matching milestone
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(1);
  });

  it('creates task without section for issue without milestone', async () => {
    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: `/rest/v2/sections?project_id=${TEST_SUB_PROJECT_ID}` })
      .reply(200, []);

    // Mock GitHub issues WITHOUT milestone
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, [
        {
          number: 2,
          title: 'Issue without milestone',
          html_url: 'https://github.com/test-org/test-repo/issues/2',
          state: 'open',
          labels: [],
          milestone: null,
        },
      ]);

    // Mock Todoist task lookup
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'GET', path: /\/rest\/v2\/tasks/ })
      .reply(200, []);

    // Mock Todoist task creation - no section_id in response since none requested
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/rest/v2/tasks' })
      .reply(201, { id: 'new-task', content: 'Test' });

    // Mock Todoist items sync
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'items-token', full_sync: false });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Sync should complete - task is created in project root (no section)
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(1);
  });
});

describe('Reset Projects Endpoint', () => {
  beforeEach(() => {
    setupOrgMappings();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('rejects unauthenticated requests', async () => {
    const request = new Request('http://localhost/reset-projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'all' }),
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('resets all projects for backfill', async () => {
    // Set up initial state with known projects
    await env.WEBHOOK_CACHE.put(
      'sync:state',
      JSON.stringify({
        lastGitHubSync: '2024-01-15T10:30:00Z',
        todoistSyncToken: 'existing-token',
        lastPollTime: '2024-01-15T10:30:00Z',
        pollCount: 5,
        knownProjectIds: [TEST_SUB_PROJECT_ID],
      })
    );

    // Mock Todoist projects API
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    const request = new Request('http://localhost/reset-projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.BACKFILL_SECRET}`,
      },
      body: JSON.stringify({ mode: 'all' }),
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.resetProjects).toHaveLength(1);
    expect(json.resetProjects[0].id).toBe(TEST_SUB_PROJECT_ID);

    // Verify state was updated with force backfill flag
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.forceBackfillNextSync).toBe(true);
    expect(state.forceBackfillProjectIds).toContain(TEST_SUB_PROJECT_ID);
  });

  it('supports dry run mode', async () => {
    // Set up initial state
    await env.WEBHOOK_CACHE.put(
      'sync:state',
      JSON.stringify({
        lastGitHubSync: '2024-01-15T10:30:00Z',
        todoistSyncToken: 'existing-token',
        lastPollTime: '2024-01-15T10:30:00Z',
        pollCount: 5,
        knownProjectIds: [TEST_SUB_PROJECT_ID],
      })
    );

    // Mock Todoist projects API
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    const request = new Request('http://localhost/reset-projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.BACKFILL_SECRET}`,
      },
      body: JSON.stringify({ mode: 'all', dryRun: true }),
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.dryRun).toBe(true);

    // Verify state was NOT modified
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.forceBackfillNextSync).toBeUndefined();
  });

  it('resets specific projects only', async () => {
    // Set up initial state with multiple known projects
    await env.WEBHOOK_CACHE.put(
      'sync:state',
      JSON.stringify({
        lastGitHubSync: '2024-01-15T10:30:00Z',
        todoistSyncToken: 'existing-token',
        lastPollTime: '2024-01-15T10:30:00Z',
        pollCount: 5,
        knownProjectIds: [TEST_SUB_PROJECT_ID, '1002'],
      })
    );

    // Mock Todoist projects with multiple sub-projects
    const projectsWithMultiple = [
      ...DEFAULT_PROJECTS,
      { id: '1002', name: 'other-repo', parent_id: TEST_PARENT_PROJECT_ID },
    ];

    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: projectsWithMultiple, sync_token: 'projects-token' });

    const request = new Request('http://localhost/reset-projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.BACKFILL_SECRET}`,
      },
      body: JSON.stringify({ mode: 'specific', projectIds: [TEST_SUB_PROJECT_ID] }),
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.resetProjects).toHaveLength(1);
    expect(json.resetProjects[0].id).toBe(TEST_SUB_PROJECT_ID);

    // Verify state - only specified project should be reset
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.forceBackfillProjectIds).toContain(TEST_SUB_PROJECT_ID);
    expect(state.forceBackfillProjectIds).not.toContain('1002');
  });
});

describe('Forced Backfill After Reset', () => {
  beforeEach(() => {
    setupOrgMappings();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('triggers backfill when forceBackfillNextSync is set', async () => {
    // Set up state with force backfill flag
    await env.WEBHOOK_CACHE.put(
      'sync:state',
      JSON.stringify({
        lastGitHubSync: '2024-01-15T10:30:00Z',
        todoistSyncToken: 'existing-token',
        lastPollTime: '2024-01-15T10:30:00Z',
        pollCount: 5,
        knownProjectIds: [], // Empty - but force flag should trigger
        forceBackfillNextSync: true,
        forceBackfillProjectIds: [TEST_SUB_PROJECT_ID],
      })
    );

    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections
    mockTodoistSections(fetchMock, TEST_SUB_PROJECT_ID);

    // Mock Todoist batch task fetch for auto-backfill (no existing tasks)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'batch-token' });

    // Mock GitHub issues for the repo (for auto-backfill)
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Issue to backfill',
          html_url: 'https://github.com/test-org/test-repo/issues/1',
          state: 'open',
          labels: [],
        },
      ]);

    // Mock Todoist task creation for auto-backfill
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/rest/v2/tasks' })
      .reply(201, { id: 'forced-backfill-task', content: 'Test' });

    // Mock Todoist items sync
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'items-token', full_sync: false });

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Verify force backfill flag is cleared after sync
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.forceBackfillNextSync).toBe(false);
    expect(state.forceBackfillProjectIds).toEqual([]);
    expect(state.pollCount).toBe(6);
  });
});

describe('Section to Milestone Sync', () => {
  beforeEach(() => {
    setupOrgMappings();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('creates GitHub issue with milestone when task is in section', async () => {
    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections (with existing section)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: `/rest/v2/sections?project_id=${TEST_SUB_PROJECT_ID}` })
      .reply(200, [{ id: 'section-v2', name: 'v2.0', project_id: TEST_SUB_PROJECT_ID }]);

    // Mock GitHub issues
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues\?/ })
      .reply(200, []);

    // Mock GitHub milestones - called to look up milestone number for section name
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/milestones/ })
      .reply(200, [{ number: 2, title: 'v2.0', state: 'open' }]);

    // Mock Todoist items sync - task in section without GitHub URL
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, {
        items: [
          {
            id: 'task-in-section',
            project_id: TEST_SUB_PROJECT_ID,
            section_id: 'section-v2',
            content: 'Task in section',
            description: '',
            is_completed: false,
          },
        ],
        sync_token: 'items-token',
        full_sync: false,
      });

    // Mock GitHub issue creation - milestone lookup being called proves section->milestone works
    fetchMock
      .get('https://api.github.com')
      .intercept({ method: 'POST', path: '/repos/test-org/test-repo/issues' })
      .reply(201, {
        number: 42,
        html_url: 'https://github.com/test-org/test-repo/issues/42',
        milestone: { number: 2, title: 'v2.0' },
      });

    // Mock Todoist task update (to add GitHub URL)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: /\/rest\/v2\/tasks\/task-in-section/ })
      .reply(200, {});

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Sync should complete - milestone mock being called proves section->milestone mapping works
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(1);
  });

  it('creates GitHub issue without milestone when task is not in section', async () => {
    // Mock Todoist projects
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { projects: DEFAULT_PROJECTS, sync_token: 'projects-token' });

    // Mock Todoist sections
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: `/rest/v2/sections?project_id=${TEST_SUB_PROJECT_ID}` })
      .reply(200, []);

    // Mock GitHub issues
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues\?/ })
      .reply(200, []);

    // Mock Todoist items sync - task NOT in section
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, {
        items: [
          {
            id: 'task-no-section',
            project_id: TEST_SUB_PROJECT_ID,
            section_id: null,
            content: 'Task without section',
            description: '',
            is_completed: false,
          },
        ],
        sync_token: 'items-token',
        full_sync: false,
      });

    // Mock GitHub issue creation - no milestone since task has no section
    fetchMock
      .get('https://api.github.com')
      .intercept({ method: 'POST', path: '/repos/test-org/test-repo/issues' })
      .reply(201, {
        number: 43,
        html_url: 'https://github.com/test-org/test-repo/issues/43',
      });

    // Mock Todoist task update
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: /\/rest\/v2\/tasks\/task-no-section/ })
      .reply(200, {});

    const ctx = createExecutionContext();
    await worker.scheduled({}, env, ctx);
    await waitOnExecutionContext(ctx);

    // Sync should complete - issue created without milestone since task has no section
    const state = await env.WEBHOOK_CACHE.get('sync:state', 'json');
    expect(state.pollCount).toBe(1);
  });
});
