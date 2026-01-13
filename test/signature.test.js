import { describe, it, expect } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker from '../src/worker.js';

// Helper to compute GitHub signature (hex-encoded HMAC-SHA256)
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

// Helper to compute Todoist signature (base64-encoded HMAC-SHA256)
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

describe('GitHub Signature Verification', () => {
  it('accepts valid GitHub signature', async () => {
    const payload = JSON.stringify({
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

    const signature = await computeGitHubSignature(payload, env.GITHUB_WEBHOOK_SECRET);

    const request = new Request('http://localhost/github-webhook', {
      method: 'POST',
      body: payload,
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

    // Should not return 401 (unauthorized)
    expect(response.status).not.toBe(401);
  });

  it('rejects invalid GitHub signature', async () => {
    const request = new Request('http://localhost/github-webhook', {
      method: 'POST',
      body: '{}',
      headers: {
        'X-Hub-Signature-256': 'sha256=invalid',
        'X-GitHub-Event': 'issues',
        'X-GitHub-Delivery': crypto.randomUUID(),
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('rejects request without GitHub signature', async () => {
    const request = new Request('http://localhost/github-webhook', {
      method: 'POST',
      body: '{}',
      headers: {
        'X-GitHub-Event': 'issues',
        'X-GitHub-Delivery': crypto.randomUUID(),
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });
});

describe('Todoist Signature Verification', () => {
  it('accepts valid Todoist signature', async () => {
    const payload = JSON.stringify({
      event_name: 'item:added',
      event_data: {
        id: 'task-123',
        content: 'Test Task',
        labels: [],
      },
    });

    const signature = await computeTodoistSignature(payload, env.TODOIST_WEBHOOK_SECRET);

    const request = new Request('http://localhost/todoist-webhook', {
      method: 'POST',
      body: payload,
      headers: {
        'X-Todoist-Hmac-SHA256': signature,
        'X-Todoist-Delivery-ID': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    // Should not return 401 (unauthorized)
    expect(response.status).not.toBe(401);
  });

  it('rejects invalid Todoist signature', async () => {
    const request = new Request('http://localhost/todoist-webhook', {
      method: 'POST',
      body: '{}',
      headers: {
        'X-Todoist-Hmac-SHA256': 'invalid-base64-signature',
        'X-Todoist-Delivery-ID': crypto.randomUUID(),
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('rejects request without Todoist signature', async () => {
    const request = new Request('http://localhost/todoist-webhook', {
      method: 'POST',
      body: '{}',
      headers: {
        'X-Todoist-Delivery-ID': crypto.randomUUID(),
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });
});
