import { describe, it, expect, beforeEach } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from 'cloudflare:test';
import worker from '../src/worker.js';

// Helper to compute GitHub signature
async function computeGitHubSignature(payload, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const hexSignature = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hexSignature}`;
}

// Helper to compute Todoist signature
async function computeTodoistSignature(payload, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// Helper to create signed GitHub request
async function createSignedGitHubRequest(payload, event = 'issues') {
  const body = JSON.stringify(payload);
  const signature = await computeGitHubSignature(body, env.GITHUB_WEBHOOK_SECRET);

  return new Request('http://localhost/github-webhook', {
    method: 'POST',
    body,
    headers: {
      'X-Hub-Signature-256': signature,
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  });
}

// Helper to create signed Todoist request
async function createSignedTodoistRequest(payload) {
  const body = JSON.stringify(payload);
  const signature = await computeTodoistSignature(body, env.TODOIST_WEBHOOK_SECRET);

  return new Request('http://localhost/todoist-webhook', {
    method: 'POST',
    body,
    headers: {
      'X-Todoist-Hmac-SHA256': signature,
      'X-Todoist-Delivery-ID': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  });
}

describe('Health Check Endpoint', () => {
  it('returns ok status', async () => {
    const request = new Request('http://localhost/health');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe('ok');
    expect(json.timestamp).toBeDefined();
  });
});

describe('404 Not Found', () => {
  it('returns 404 for unknown routes', async () => {
    const request = new Request('http://localhost/unknown');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });

  it('returns 404 for GET on webhook endpoints', async () => {
    const request = new Request('http://localhost/github-webhook');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });
});

describe('GitHub Webhook Handler', () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('ignores non-issue events', async () => {
    const request = await createSignedGitHubRequest(
      { action: 'created' },
      'push'
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.message).toBe('Event ignored');
  });

  it('ignores unhandled issue actions', async () => {
    const request = await createSignedGitHubRequest({
      action: 'labeled',
      issue: {
        number: 1,
        title: 'Test Issue',
        html_url: 'https://github.com/test-org/test-repo/issues/1',
        labels: [],
      },
      repository: {
        name: 'test-repo',
        full_name: 'test-org/test-repo',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.message).toBe('Event ignored');
    expect(json.action).toBe('labeled');
  });

  it('creates Todoist task when issue opened', async () => {
    // Mock Todoist API calls
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: /\/rest\/v2\/tasks/ })
      .reply(200, []); // No existing tasks

    fetchMock
      .get('https://api.todoist.com')
      .intercept({ method: 'POST', path: '/rest/v2/tasks' })
      .reply(201, { id: 'task-123', content: 'Test Task' });

    const request = await createSignedGitHubRequest({
      action: 'opened',
      issue: {
        number: 1,
        title: 'Test Issue',
        html_url: 'https://github.com/test-org/test-repo/issues/1',
        labels: [],
      },
      repository: {
        name: 'test-repo',
        full_name: 'test-org/test-repo',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.message).toBe('Task created');
    expect(json.taskId).toBe('task-123');
  });

  it('skips task creation if task already exists', async () => {
    // Mock Todoist API - return existing task
    fetchMock
      .get('https://api.todoist.com')
      .intercept({ path: /\/rest\/v2\/tasks/ })
      .reply(200, [
        {
          id: 'existing-task',
          content: 'Test',
          description: 'https://github.com/test-org/test-repo/issues/1',
        },
      ]);

    const request = await createSignedGitHubRequest({
      action: 'opened',
      issue: {
        number: 1,
        title: 'Test Issue',
        html_url: 'https://github.com/test-org/test-repo/issues/1',
        labels: [],
      },
      repository: {
        name: 'test-repo',
        full_name: 'test-org/test-repo',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.message).toBe('Task already exists');
  });

  it('returns 400 for invalid JSON', async () => {
    const body = 'invalid json';
    const signature = await computeGitHubSignature(body, env.GITHUB_WEBHOOK_SECRET);

    const request = new Request('http://localhost/github-webhook', {
      method: 'POST',
      body,
      headers: {
        'X-Hub-Signature-256': signature,
        'X-GitHub-Event': 'issues',
        'X-GitHub-Delivery': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe('Invalid JSON payload');
  });
});

describe('Todoist Webhook Handler', () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it('ignores unhandled events', async () => {
    const request = await createSignedTodoistRequest({
      event_name: 'item:deleted',
      event_data: { id: 'task-123' },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.message).toBe('Event ignored');
  });

  it('skips task without repo label', async () => {
    const request = await createSignedTodoistRequest({
      event_name: 'item:added',
      event_data: {
        id: 'task-123',
        content: 'Test Task',
        labels: [],
        description: '',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.message).toBe('No repo label found, skipped');
  });

  it('skips task with existing GitHub URL (loop prevention)', async () => {
    const request = await createSignedTodoistRequest({
      event_name: 'item:added',
      event_data: {
        id: 'task-123',
        content: 'Test Task',
        labels: ['my-repo'],
        description: 'https://github.com/test-org/test-repo/issues/1',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.message).toBe('Task has GitHub URL, skipped (loop prevention)');
  });

  it('closes GitHub issue when task completed', async () => {
    // Mock GitHub API
    fetchMock
      .get('https://api.github.com')
      .intercept({ method: 'PATCH', path: '/repos/test-org/test-repo/issues/1' })
      .reply(200, { number: 1, state: 'closed' });

    const request = await createSignedTodoistRequest({
      event_name: 'item:completed',
      event_data: {
        id: 'task-123',
        content: 'Test Task',
        description: 'https://github.com/test-org/test-repo/issues/1',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.message).toBe('Issue closed');
  });

  it('skips completed task without GitHub URL', async () => {
    const request = await createSignedTodoistRequest({
      event_name: 'item:completed',
      event_data: {
        id: 'task-123',
        content: 'Test Task',
        description: 'Some other description',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.message).toBe('No GitHub URL in task, skipped');
  });

  it('reopens GitHub issue when task uncompleted', async () => {
    // Mock GitHub API
    fetchMock
      .get('https://api.github.com')
      .intercept({ method: 'PATCH', path: '/repos/test-org/test-repo/issues/1' })
      .reply(200, { number: 1, state: 'open' });

    const request = await createSignedTodoistRequest({
      event_name: 'item:uncompleted',
      event_data: {
        id: 'task-123',
        content: 'Test Task',
        description: 'https://github.com/test-org/test-repo/issues/1',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.message).toBe('Issue reopened');
  });

  it('returns 400 for invalid JSON', async () => {
    const body = 'invalid json';
    const signature = await computeTodoistSignature(body, env.TODOIST_WEBHOOK_SECRET);

    const request = new Request('http://localhost/todoist-webhook', {
      method: 'POST',
      body,
      headers: {
        'X-Todoist-Hmac-SHA256': signature,
        'X-Todoist-Delivery-ID': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe('Invalid JSON payload');
  });
});
