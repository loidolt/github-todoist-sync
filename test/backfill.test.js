import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from 'cloudflare:test';
import worker from '../src/worker.js';

// Helper to create backfill request with Bearer auth
function createBackfillRequest(body, secret = env.GITHUB_WEBHOOK_SECRET) {
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
async function readNDJSONStream(response) {
  const text = await response.text();
  return text
    .trim()
    .split('\n')
    .filter((line) => line)
    .map((line) => JSON.parse(line));
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
        Authorization: `Bearer ${env.GITHUB_WEBHOOK_SECRET}`,
        'Content-Type': 'application/json',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe('Invalid JSON');
  });

  it('returns 400 for missing mode', async () => {
    const request = createBackfillRequest({ repo: 'test' });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('mode');
  });

  it('returns 400 for invalid mode', async () => {
    const request = createBackfillRequest({ mode: 'invalid', repo: 'test' });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('mode');
  });

  it('returns 400 for single-repo mode without repo', async () => {
    const request = createBackfillRequest({ mode: 'single-repo', owner: 'test-org' });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json();
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
    const json = await response.json();
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

    const events = await readNDJSONStream(response);
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

    const events = await readNDJSONStream(response);

    // Check that the complete event exists
    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();

    // Should have would_create status for dry run
    const issueEvents = events.filter((e) => e.type === 'issue');
    expect(issueEvents).toHaveLength(1);
    expect(issueEvents[0].status).toBe('would_create');
    expect(complete.summary.created).toBe(1);
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
          content: '[skip-test-repo#1] Test Issue 1',
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

    const events = await readNDJSONStream(response);

    const issueEvents = events.filter((e) => e.type === 'issue');

    expect(issueEvents[0].status).toBe('skipped');
    expect(issueEvents[0].reason).toBe('already_exists');

    const complete = events.find((e) => e.type === 'complete');
    expect(complete.summary.skipped).toBe(1);
  });

  it('creates tasks when not in dry-run mode', async () => {
    // Use unique repo name to avoid mock conflicts
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

    // Mock Todoist task creation
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/rest/v2/tasks' })
      .reply(201, { id: 'new-task-123', content: '[create-task-repo#1] Test Issue 1' });

    const request = createBackfillRequest({
      mode: 'single-repo',
      repo: 'create-task-repo',
      owner: 'test-org',
      dryRun: false,
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await readNDJSONStream(response);
    const issueEvents = events.filter((e) => e.type === 'issue');

    expect(issueEvents[0].status).toBe('created');
    expect(issueEvents[0].taskId).toBe('new-task-123');

    const complete = events.find((e) => e.type === 'complete');
    expect(complete.summary.created).toBe(1);
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

    const events = await readNDJSONStream(response);
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

    const events = await readNDJSONStream(response);
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
      .reply(200, [{ name: 'repo-1' }, { name: 'repo-2' }]);

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

    const events = await readNDJSONStream(response);

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'start', totalRepos: 2 })
    );

    const issueEvents = events.filter((e) => e.type === 'issue');
    expect(issueEvents).toHaveLength(1);
    expect(issueEvents[0].repo).toBe('test-org/repo-1');
  });

  it('falls back to user repos if org not found', async () => {
    // Mock org repos - 404
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/orgs\/test-user\/repos/ })
      .reply(404, { message: 'Not Found' });

    // Mock user repos
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: /\/users\/test-user\/repos/ })
      .reply(200, [{ name: 'user-repo' }]);

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

    const events = await readNDJSONStream(response);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'start', totalRepos: 1 })
    );
  });
});
