import type { HealthResponse } from '../types/api.js';
import { jsonResponse } from '../utils/helpers.js';

/**
 * Handle GET /health request
 */
export function handleHealth(): Response {
  const response: HealthResponse = {
    status: 'ok',
    timestamp: new Date().toISOString(),
  };
  return jsonResponse(response);
}
