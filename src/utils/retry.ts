import { CONSTANTS } from '../config/constants.js';

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Add random jitter to prevent thundering herd
 * Returns a random value between 0 and maxMs
 */
export function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

/**
 * Extended error with retry-after information
 */
export interface RetryableError extends Error {
  retryAfter?: number;
}

/**
 * Options for the retry wrapper
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
}

/**
 * Retry wrapper with exponential backoff and jitter
 * Handles 429 rate limit errors with Retry-After header support
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = CONSTANTS.MAX_RETRIES,
    baseDelay = CONSTANTS.BASE_RETRY_DELAY_MS,
    maxDelay = CONSTANTS.MAX_RETRY_DELAY_MS,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check for HTTP status in error message
      // Error messages are formatted as "API error: {status} - {message}"
      const statusMatch = lastError.message?.match(/API error: (\d{3})/);
      const statusStr = statusMatch?.[1];
      if (statusStr) {
        const status = parseInt(statusStr, 10);

        // Handle rate limiting (429) - always retry with backoff
        if (status === 429) {
          if (attempt < maxRetries) {
            // Use Retry-After header if available, otherwise exponential backoff
            const retryableError = error as RetryableError;
            const retryAfterMs = retryableError.retryAfter ?? baseDelay * Math.pow(2, attempt);
            const waitTime = Math.min(retryAfterMs, maxDelay) + jitter(100);
            console.log(
              `Rate limited (429), waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`
            );
            await sleep(waitTime);
            continue;
          }
        }

        // Don't retry on other 4xx client errors
        if (status >= 400 && status < 500) {
          throw lastError;
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
