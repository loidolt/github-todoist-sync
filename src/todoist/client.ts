import type { Env } from '../types/env.js';
import { CONSTANTS } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';

/**
 * Get Todoist API authorization headers
 */
export function getTodoistHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
  };
}

/**
 * Make a Todoist REST API request with retry logic
 */
export async function todoistFetch<T>(
  env: Env,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  return withRetry(async () => {
    const url = path.startsWith('http') ? path : `${CONSTANTS.TODOIST_API_BASE}/rest/v2${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        ...getTodoistHeaders(env),
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  });
}

/**
 * Make a Todoist REST API request that returns void
 */
export async function todoistFetchVoid(
  env: Env,
  path: string,
  options: RequestInit = {}
): Promise<void> {
  return withRetry(async () => {
    const url = path.startsWith('http') ? path : `${CONSTANTS.TODOIST_API_BASE}/rest/v2${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        ...getTodoistHeaders(env),
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
    }
  });
}

/**
 * Make a Todoist Sync API request
 */
export async function todoistSyncFetch<T>(
  env: Env,
  body: Record<string, unknown>
): Promise<T> {
  return withRetry(async () => {
    const response = await fetch(`${CONSTANTS.TODOIST_API_BASE}/sync/v9/sync`, {
      method: 'POST',
      headers: {
        ...getTodoistHeaders(env),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Todoist Sync API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  });
}

/**
 * Simple token bucket rate limiter for API calls
 */
export class RateLimiter {
  private requestsPerMinute: number;
  private tokens: number;
  private lastRefill: number;

  constructor(requestsPerMinute: number) {
    this.requestsPerMinute = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.lastRefill = Date.now();
  }

  async waitForToken(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillAmount = (elapsed / 60000) * this.requestsPerMinute;
    this.tokens = Math.min(this.requestsPerMinute, this.tokens + refillAmount);
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitTime = ((1 - this.tokens) / this.requestsPerMinute) * 60000;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.tokens = 1;
    }
    this.tokens -= 1;
  }
}
