# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Cloudflare Worker that provides full bidirectional sync between GitHub issues and Todoist tasks:
- GitHub issue opened → creates Todoist task
- GitHub issue closed → completes Todoist task
- GitHub issue edited → updates Todoist task title
- GitHub issue reopened → reopens Todoist task
- Todoist task created (with repo label) → creates GitHub issue
- Todoist task completed → closes GitHub issue
- Todoist task updated → updates GitHub issue title
- Todoist task uncompleted → reopens GitHub issue

## Commands

```bash
npm run dev      # Start local development server
npm run deploy   # Deploy to Cloudflare Workers
npm run tail     # Stream live logs from deployed worker
npm test         # Run tests with Vitest
```

Setup before deploying:
```bash
# Create KV namespace for idempotency
npx wrangler kv:namespace create "WEBHOOK_CACHE"
# Update wrangler.toml with the returned namespace ID

# Add secrets
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TODOIST_API_TOKEN
npx wrangler secret put TODOIST_WEBHOOK_SECRET
npx wrangler secret put TODOIST_PROJECT_ID
npx wrangler secret put GITHUB_ORG  # Optional: for Todoist→GitHub sync (e.g., "your-org")
```

## Architecture

Single-file worker (`src/worker.js`) with four HTTP routes:
- `POST /github-webhook` - Receives GitHub issue events, creates/completes/updates Todoist tasks
- `POST /todoist-webhook` - Receives Todoist events, creates/closes/updates GitHub issues
- `POST /backfill` - Backfill existing GitHub issues to Todoist (requires Bearer auth)
- `GET /health` - Health check endpoint

### Key Flows

1. **GitHub issue opened → Todoist task created**: GitHub webhook fires on `issues.opened` → worker checks for duplicates → creates Todoist task with issue URL in description
2. **GitHub issue closed → Todoist task completed**: GitHub webhook fires on `issues.closed` → worker finds task by URL → completes the task
3. **GitHub issue edited → Todoist task updated**: GitHub webhook fires on `issues.edited` → worker finds task by URL → updates task title
4. **GitHub issue reopened → Todoist task reopened**: GitHub webhook fires on `issues.reopened` → worker finds task by URL → reopens the task
5. **Todoist task created → GitHub issue created**: Todoist webhook fires on `item:added` → worker checks for repo label → creates issue in `GITHUB_ORG/{label}` → updates task description with issue URL
6. **Todoist task completed → GitHub issue closed**: Todoist webhook fires on `item:completed` → worker parses GitHub URL from task description → closes issue via GitHub API
7. **Todoist task updated → GitHub issue updated**: Todoist webhook fires on `item:updated` → worker parses GitHub URL → updates issue title
8. **Todoist task uncompleted → GitHub issue reopened**: Todoist webhook fires on `item:uncompleted` → worker parses GitHub URL → reopens the issue

### Features

- **Full bidirectional sync**: Create, edit, close, and reopen issues/tasks from either platform
- **Label-based repo routing**: Supports two formats:
  - Simple: `repo-name` → uses `GITHUB_ORG/repo-name`
  - Explicit: `owner/repo-name` → uses `owner/repo-name` (for multi-org support)
- **Duplicate prevention**: Checks existing tasks before creating new ones
- **Loop prevention**: Tasks with GitHub URLs in description won't create new issues
- **Idempotency**: Uses KV store to prevent duplicate webhook processing
- **Retry logic**: Exponential backoff for transient API failures
- **Efficient queries**: Uses Todoist filter API to avoid pagination issues

### Webhook Signature Verification

Both webhooks use HMAC-SHA256 verification but with different formats:
- GitHub: hex-encoded signature with `sha256=` prefix
- Todoist: base64-encoded signature

### Backfill Endpoint

The `/backfill` endpoint syncs existing GitHub issues to Todoist. Authentication uses Bearer token (set `BACKFILL_SECRET` or falls back to `GITHUB_WEBHOOK_SECRET`).

**Request:**
```bash
# Dry-run for single repo (preview what would be created)
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "single-repo", "repo": "my-repo", "dryRun": true}'

# Backfill single repo (open issues only)
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "single-repo", "repo": "my-repo"}'

# Backfill entire org
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "org", "state": "open"}'
```

**Parameters:**
- `mode`: `"single-repo"` or `"org"` (required)
- `repo`: Repository name (required for single-repo mode)
- `owner`: GitHub owner/org (optional, defaults to `GITHUB_ORG`)
- `state`: `"open"`, `"closed"`, or `"all"` (default: `"open"`)
- `dryRun`: `true` to preview without creating tasks (default: `false`)
- `limit`: Max issues to process (optional, useful for testing)

**Response:** Streaming NDJSON with real-time progress:
```json
{"type": "start", "totalRepos": 1, "dryRun": true}
{"type": "issue", "repo": "owner/repo", "issue": 1, "title": "...", "status": "would_create"}
{"type": "issue", "repo": "owner/repo", "issue": 2, "title": "...", "status": "skipped", "reason": "already_exists"}
{"type": "repo_complete", "repo": "owner/repo", "issues": 2}
{"type": "complete", "summary": {"total": 2, "created": 1, "skipped": 1, "failed": 0}}
```

## Testing

Tests are located in the `test/` directory:
- `test/signature.test.js` - Signature verification tests
- `test/parsing.test.js` - URL and label parsing tests
- `test/webhook.test.js` - Webhook handler integration tests
- `test/backfill.test.js` - Backfill endpoint tests

Run tests with `npm test`.

## CI/CD

Deployments are handled via GitHub Actions (`.github/workflows/ci.yml`):
- Tests run on all pull requests and pushes to `main`
- Deployment to Cloudflare Workers runs on push to `main` after tests pass

### GitHub Environment Setup

1. Create a `production` environment in your GitHub repo settings (Settings → Environments → New environment)

2. Add the following secrets to the `production` environment:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `KV_NAMESPACE_ID` | The KV namespace ID for webhook idempotency |
| `WORKER_GITHUB_WEBHOOK_SECRET` | Secret for GitHub webhook verification |
| `WORKER_GITHUB_TOKEN` | GitHub PAT for creating/updating issues |
| `TODOIST_API_TOKEN` | Todoist API token |
| `TODOIST_WEBHOOK_SECRET` | Secret for Todoist webhook verification |
| `TODOIST_PROJECT_ID` | Todoist project ID for tasks |
| `GITHUB_ORG` | Default GitHub org for Todoist→GitHub sync (optional) |
| `BACKFILL_SECRET` | Secret for backfill endpoint auth (optional, falls back to `WORKER_GITHUB_WEBHOOK_SECRET`) |

3. Create the KV namespace (if not already created):
```bash
npx wrangler kv:namespace create "WEBHOOK_CACHE"
# Copy the ID to KV_NAMESPACE_ID secret
```

4. Create a Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens with:
   - Account: Workers Scripts: Edit
   - Account: Workers KV Storage: Edit
