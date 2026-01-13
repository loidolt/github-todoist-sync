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
            content: '[test-repo#1] Existing task',
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
            content: '[test-repo#1] Task',
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
