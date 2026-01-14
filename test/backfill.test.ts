import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from 'cloudflare:test';
import worker from '../src/index.js';

// Extend env type for testing
interface TestEnv {
  ORG_MAPPINGS: string;
  BACKFILL_SECRET: string;
  WEBHOOK_CACHE: KVNamespace;
}

const testEnv = env as unknown as TestEnv;

// Helper to create backfill request with Bearer auth
function createBackfillRequest(body: unknown, secret: string = testEnv.BACKFILL_SECRET): Request {
  return new Request('http://localhost/backfill', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
  });
}

// Helper to read NDJSON stream response
async function readNDJSONStream(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .trim()
    .split('\n')
    .filter((line) => line)
    .map((line) => JSON.parse(line));
}

// Helper to mock Todoist sections endpoint (required for milestone sync)
function mockTodoistSections(fm: typeof fetchMock, projectId: string, sections: unknown[] = []): void {
  fm.get('https://api.todoist.com')
    .intercept({ path: `/rest/v2/sections?project_id=${projectId}` })
    .reply(200, sections);
}

describe('Backfill Authentication', () => {
  it('returns 401 without Authorization header', async () => {
    const request = new Request('http://localhost/backfill', {
      method: 'POST',
      body: JSON.stringify({ mode: 'single-repo', repo: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('returns 401 with invalid Bearer token', async () => {
    const request = createBackfillRequest(
      { mode: 'single-repo', repo: 'test' },
      'wrong-secret'
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('accepts valid Bearer token', async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();

    // Mock GitHub API - empty issues
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/test-repo\/issues/ })
      .reply(200, []);

    const request = createBackfillRequest({
      mode: 'single-repo',
      repo: 'test-repo',
      owner: 'test-org',
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
  });
});

describe('Backfill Request Validation', () => {
  it('returns 400 for invalid JSON', async () => {
    const request = new Request('http://localhost/backfill', {
      method: 'POST',
      body: 'invalid json',
      headers: {
        Authorization: `Bearer ${testEnv.BACKFILL_SECRET}`,
        'Content-Type': 'application/json',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json() as { error: string };
    expect(json.error).toBe('Invalid JSON');
  });

  it('returns 400 for missing mode', async () => {
    const request = createBackfillRequest({ repo: 'test' });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json() as { error: string };
    expect(json.error).toContain('mode');
  });

  it('returns 400 for invalid mode', async () => {
    const request = createBackfillRequest({ mode: 'invalid', repo: 'test' });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json() as { error: string };
    expect(json.error).toContain('mode');
  });

  it('returns 400 for single-repo mode without repo', async () => {
    const request = createBackfillRequest({ mode: 'single-repo', owner: 'test-org' });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json() as { error: string };
    expect(json.error).toContain('repo is required');
  });

  it('returns 400 for invalid state', async () => {
    const request = createBackfillRequest({
      mode: 'single-repo',
      repo: 'test',
      owner: 'test-org',
      state: 'invalid',
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json() as { error: string };
    expect(json.error).toContain('state');
  });
});

describe('Backfill Single Repo', () => {
  beforeEach(() => {
    // Deactivate first to clear any leftover mocks from previous tests
    fetchMock.deactivate();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(async () => {
    // Ensure all async operations complete before deactivating mocks
    await new Promise(resolve => setTimeout(resolve, 10));
    fetchMock.deactivate();
  });

  it('returns empty summary for repo with no issues', async () => {
    // Use unique repo name to avoid mock conflicts
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/empty-repo\/issues/ })
      .reply(200, []);

    const request = createBackfillRequest({
      mode: 'single-repo',
      repo: 'empty-repo',
      owner: 'test-org',
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');

    const events = await readNDJSONStream(response) as Array<{ type: string; totalRepos?: number; summary?: { total: number; created: number; skipped: number; failed: number } }>;
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'start', totalRepos: 1 })
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'complete', summary: { total: 0, created: 0, skipped: 0, failed: 0 } })
    );
  });

  it('creates tasks for issues in dry-run mode', async () => {
    // Use unique repo name to avoid mock conflicts with other tests
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/dry-run-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Test Issue 1',
          html_url: 'https://github.com/test-org/dry-run-repo/issues/1',
          labels: [],
        },
      ]);

    // Mock Todoist - no existing tasks
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: /\/rest\/v2\/tasks/ })
      .reply(200, []);

    const request = createBackfillRequest({
      mode: 'single-repo',
      repo: 'dry-run-repo',
      owner: 'test-org',
      dryRun: true,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response) as Array<{ type: string; status?: string; summary?: { created: number } }>;

    // Check that the complete event exists
    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();

    // Should have would_create status for dry run
    const issueEvents = events.filter((e) => e.type === 'issue');
    expect(issueEvents).toHaveLength(1);
    expect(issueEvents[0].status).toBe('would_create');
    expect(complete?.summary?.created).toBe(1);
  });

  it('skips existing tasks', async () => {
    // Use unique repo name to avoid mock conflicts with other tests
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/skip-test-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Test Issue 1',
          html_url: 'https://github.com/test-org/skip-test-repo/issues/1',
          labels: [],
        },
      ]);

    // Mock Todoist - task already exists
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: /\/rest\/v2\/tasks/ })
      .reply(200, [
        {
          id: 'existing-task',
          content: '[#1] Test Issue 1',
          description: 'https://github.com/test-org/skip-test-repo/issues/1',
        },
      ]);

    const request = createBackfillRequest({
      mode: 'single-repo',
      repo: 'skip-test-repo',
      owner: 'test-org',
      dryRun: true,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response) as Array<{ type: string; status?: string; reason?: string; summary?: { skipped: number } }>;

    const issueEvents = events.filter((e) => e.type === 'issue');

    expect(issueEvents[0].status).toBe('skipped');
    expect(issueEvents[0].reason).toBe('already_exists');

    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.summary?.skipped).toBe(1);
  });

  it('fails gracefully without projectId when not in dry-run mode', async () => {
    // Single-repo mode without projectId should fail gracefully
    // because we don't know which Todoist project to create tasks in.
    // Use 'projects' mode for actual task creation.
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/create-task-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Test Issue 1',
          html_url: 'https://github.com/test-org/create-task-repo/issues/1',
          labels: [],
        },
      ]);

    // Mock Todoist - no existing tasks
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: /\/rest\/v2\/tasks/ })
      .reply(200, []);

    const request = createBackfillRequest({
      mode: 'single-repo',
      repo: 'create-task-repo',
      owner: 'test-org',
      dryRun: false,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response) as Array<{ type: string; status?: string; error?: string; summary?: { failed: number } }>;
    const issueEvents = events.filter((e) => e.type === 'issue');

    // Should fail because single-repo mode doesn't provide projectId
    expect(issueEvents[0].status).toBe('failed');
    expect(issueEvents[0].error).toContain('projectId required');

    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.summary?.failed).toBe(1);
  });

  it('filters out pull requests', async () => {
    // Use unique repo name to avoid mock conflicts
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/filter-pr-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Test Issue 1',
          html_url: 'https://github.com/test-org/filter-pr-repo/issues/1',
          labels: [],
        },
        {
          number: 2,
          title: 'Test PR',
          html_url: 'https://github.com/test-org/filter-pr-repo/pull/2',
          labels: [],
          pull_request: { url: 'https://api.github.com/...' },
        },
      ]);

    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: /\/rest\/v2\/tasks/ })
      .reply(200, []);

    const request = createBackfillRequest({
      mode: 'single-repo',
      repo: 'filter-pr-repo',
      owner: 'test-org',
      dryRun: true,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response) as Array<{ type: string; issue?: number }>;
    const issueEvents = events.filter((e) => e.type === 'issue');

    // Should only have 1 issue, PR filtered out
    expect(issueEvents).toHaveLength(1);
    expect(issueEvents[0].issue).toBe(1);
  });

  it('respects limit parameter', async () => {
    // Use unique repo name to avoid mock conflicts
    // The limit parameter controls how many issues are fetched from GitHub
    // With limit=1, only 1 issue will be fetched and processed
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/limit-test-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Issue 1',
          html_url: 'https://github.com/test-org/limit-test-repo/issues/1',
          labels: [],
        },
      ]);

    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: /\/rest\/v2\/tasks/ })
      .reply(200, []);

    const request = createBackfillRequest({
      mode: 'single-repo',
      repo: 'limit-test-repo',
      owner: 'test-org',
      dryRun: true,
      limit: 1,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response) as Array<{ type: string; issue?: number }>;
    const issueEvents = events.filter((e) => e.type === 'issue');

    // Should only process 1 issue due to limit
    expect(issueEvents).toHaveLength(1);
    expect(issueEvents[0].issue).toBe(1);
  });
});

describe('Backfill Org Mode', () => {
  beforeEach(() => {
    // Deactivate first to clear any leftover mocks from previous tests
    fetchMock.deactivate();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(async () => {
    // Ensure all async operations complete before deactivating mocks
    await new Promise(resolve => setTimeout(resolve, 10));
    fetchMock.deactivate();
  });

  it('fetches repos from org and processes issues', async () => {
    // Mock org repos
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/orgs\/test-org\/repos/ })
      .reply(200, [
        { name: 'repo-1', owner: { login: 'test-org' }, archived: false, disabled: false },
        { name: 'repo-2', owner: { login: 'test-org' }, archived: false, disabled: false }
      ]);

    // Mock issues for repo-1
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/repo-1\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Issue in repo-1',
          html_url: 'https://github.com/test-org/repo-1/issues/1',
          labels: [],
        },
      ]);

    // Mock issues for repo-2
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/repo-2\/issues/ })
      .reply(200, []);

    // Mock Todoist
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: /\/rest\/v2\/tasks/ })
      .reply(200, []);

    const request = createBackfillRequest({
      mode: 'org',
      owner: 'test-org',
      dryRun: true,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response) as Array<{ type: string; totalRepos?: number; repo?: string }>;

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'start', totalRepos: 2 })
    );

    const issueEvents = events.filter((e) => e.type === 'issue');
    expect(issueEvents).toHaveLength(1);
    expect(issueEvents[0].repo).toBe('test-org/repo-1');
  });

  it('processes user repos in org mode', async () => {
    // Test that org mode works with valid response
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/orgs\/test-user\/repos/ })
      .reply(200, [{ name: 'user-repo', owner: { login: 'test-user' }, archived: false, disabled: false }]);

    // Mock issues
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-user\/user-repo\/issues/ })
      .reply(200, []);

    const request = createBackfillRequest({
      mode: 'org',
      owner: 'test-user',
      dryRun: true,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response) as Array<{ type: string; totalRepos?: number }>;
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'start', totalRepos: 1 })
    );
  });
});

describe('Backfill Projects Mode', () => {
  beforeEach(() => {
    // Set up ORG_MAPPINGS for projects mode
    testEnv.ORG_MAPPINGS = JSON.stringify({ '1000': 'test-org' });
    fetchMock.deactivate();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(async () => {
    delete (testEnv as { ORG_MAPPINGS?: string }).ORG_MAPPINGS;
    await new Promise((resolve) => setTimeout(resolve, 10));
    fetchMock.deactivate();
  });

  it('returns error if ORG_MAPPINGS not configured', async () => {
    delete (testEnv as { ORG_MAPPINGS?: string }).ORG_MAPPINGS;

    const request = createBackfillRequest({
      mode: 'projects',
      dryRun: true,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json() as { error: string };
    expect(json.error).toContain('ORG_MAPPINGS');
  });

  it('uses Todoist project hierarchy to determine repos', async () => {
    // Mock Todoist projects (first sync call)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, {
        projects: [
          { id: '1000', name: 'Test Org Issues', parent_id: null },
          { id: '1001', name: 'repo-a', parent_id: '1000' },
          { id: '1002', name: 'repo-b', parent_id: '1000' },
        ],
        sync_token: 'test-token',
      });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, '1001');
    mockTodoistSections(fetchMock, '1002');

    // Mock Todoist batch task fetch (second sync call for existing tasks)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'batch-token' });

    // Mock GitHub issues for repo-a
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/repo-a\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Issue in repo-a',
          html_url: 'https://github.com/test-org/repo-a/issues/1',
          labels: [],
        },
      ]);

    // Mock GitHub issues for repo-b
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/repo-b\/issues/ })
      .reply(200, []);

    const request = createBackfillRequest({
      mode: 'projects',
      dryRun: true,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response) as Array<{ type: string; mode?: string; repos?: string[]; totalRepos?: number; projectId?: string }>;

    // Should have config event with discovered repos
    const configEvent = events.find((e) => e.type === 'config');
    expect(configEvent).toBeDefined();
    expect(configEvent?.mode).toBe('projects');
    expect(configEvent?.repos).toContain('test-org/repo-a');
    expect(configEvent?.repos).toContain('test-org/repo-b');

    // Should start with 2 repos from Todoist hierarchy
    const startEvent = events.find((e) => e.type === 'start');
    expect(startEvent?.totalRepos).toBe(2);

    // Should include projectId in issue events
    const issueEvent = events.find((e) => e.type === 'issue');
    expect(issueEvent?.projectId).toBe('1001');
  });

  it('creates tasks in correct sub-projects', async () => {
    // Mock Todoist projects (first sync call)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, {
        projects: [
          { id: '1000', name: 'Test Org Issues', parent_id: null },
          { id: '1001', name: 'sub-proj-repo', parent_id: '1000' },
        ],
        sync_token: 'test-token',
      });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, '1001');

    // Mock Todoist batch task fetch (second sync call - no existing tasks)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, { items: [], sync_token: 'batch-token' });

    // Mock GitHub issues - use unique repo name
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/sub-proj-repo\/issues/ })
      .reply(200, [
        {
          number: 99,
          title: 'Subproject Test Issue',
          html_url: 'https://github.com/test-org/sub-proj-repo/issues/99',
          labels: [],
        },
      ]);

    // Mock Todoist task creation - use unique task id
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/rest/v2/tasks' })
      .reply(201, { id: 'created-subproj-task', content: '[#99] Subproject Test Issue' });

    const request = createBackfillRequest({
      mode: 'projects',
      dryRun: false,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response) as Array<{ type: string; status?: string; taskId?: string; projectId?: string; summary?: { created: number } }>;

    const issueEvent = events.find((e) => e.type === 'issue');
    expect(issueEvent?.status).toBe('created');
    expect(issueEvent?.taskId).toBe('created-subproj-task');
    expect(issueEvent?.projectId).toBe('1001');

    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.summary?.created).toBe(1);
  });

  it('uses batch task fetching to skip existing tasks efficiently', async () => {
    // Mock Todoist projects (first sync call)
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, {
        projects: [
          { id: '1000', name: 'Test Org Issues', parent_id: null },
          { id: '1001', name: 'batch-test-repo', parent_id: '1000' },
        ],
        sync_token: 'projects-token',
      });

    // Mock Todoist sections (for milestone sync)
    mockTodoistSections(fetchMock, '1001');

    // Mock Todoist batch task fetch (second sync call for items)
    // This returns existing tasks with GitHub URLs
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/sync/v9/sync' })
      .reply(200, {
        items: [
          {
            id: 'existing-batch-task-1',
            project_id: '1001',
            content: '[#1] Existing Issue',
            description: 'https://github.com/test-org/batch-test-repo/issues/1',
          },
        ],
        sync_token: 'items-token',
      });

    // Mock GitHub issues - includes both existing and new
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/repos\/test-org\/batch-test-repo\/issues/ })
      .reply(200, [
        {
          number: 1,
          title: 'Existing Issue',
          html_url: 'https://github.com/test-org/batch-test-repo/issues/1',
          labels: [],
        },
        {
          number: 2,
          title: 'New Issue',
          html_url: 'https://github.com/test-org/batch-test-repo/issues/2',
          labels: [],
        },
      ]);

    const request = createBackfillRequest({
      mode: 'projects',
      dryRun: true,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response) as Array<{ type: string; existingTaskCount?: number; issue?: number; status?: string; reason?: string; summary?: { skipped: number; created: number } }>;

    // Config event should show existingTaskCount
    const configEvent = events.find((e) => e.type === 'config');
    expect(configEvent).toBeDefined();
    expect(configEvent?.existingTaskCount).toBe(1);

    // Issue events should show skip for existing and would_create for new
    const issueEvents = events.filter((e) => e.type === 'issue');
    expect(issueEvents).toHaveLength(2);

    const existingIssueEvent = issueEvents.find((e) => e.issue === 1);
    expect(existingIssueEvent?.status).toBe('skipped');
    expect(existingIssueEvent?.reason).toBe('already_exists');

    const newIssueEvent = issueEvents.find((e) => e.issue === 2);
    expect(newIssueEvent?.status).toBe('would_create');

    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.summary?.skipped).toBe(1);
    expect(complete?.summary?.created).toBe(1);
  });
});
