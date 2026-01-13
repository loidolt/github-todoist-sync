# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Cloudflare Worker that provides bidirectional sync between GitHub issues and Todoist tasks using polling-based sync (no webhooks required):
- GitHub issue opened → creates Todoist task in corresponding sub-project
- GitHub issue closed → completes Todoist task
- GitHub issue reopened → reopens Todoist task
- Todoist task created (in sub-project) → creates GitHub issue in corresponding repo
- Todoist task completed → closes GitHub issue
- Todoist task uncompleted → reopens GitHub issue

Sync runs every 15 minutes via Cloudflare Cron Triggers.

## Commands

```bash
npm run dev      # Start local development server
npm run deploy   # Deploy to Cloudflare Workers
npm run tail     # Stream live logs from deployed worker
npm test         # Run tests with Vitest
```

Setup before deploying:
```bash
# Create KV namespace for sync state
npx wrangler kv:namespace create "WEBHOOK_CACHE"
# Update wrangler.toml with the returned namespace ID

# Add secrets
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TODOIST_API_TOKEN
npx wrangler secret put ORG_MAPPINGS  # JSON mapping Todoist project IDs to GitHub orgs
npx wrangler secret put BACKFILL_SECRET  # Optional: for backfill endpoint auth
```

### ORG_MAPPINGS Configuration

The `ORG_MAPPINGS` environment variable defines which Todoist projects map to which GitHub organizations. The sync uses Todoist's project hierarchy to determine which repos to sync:

- **Parent projects** map to GitHub organizations
- **Sub-projects** map to repository names

**Example Todoist structure:**
```
Issues (parent project)           → maps to "my-org" GitHub org
├── api                          → syncs with my-org/api
├── web-app                      → syncs with my-org/web-app
└── docs                         → syncs with my-org/docs

Client Projects (parent project)  → maps to "client-org" GitHub org
├── project-a                    → syncs with client-org/project-a
└── project-b                    → syncs with client-org/project-b
```

**ORG_MAPPINGS format** (JSON object mapping Todoist parent project ID → GitHub org):
```json
{
  "2365501087": "my-org",
  "2365501088": "client-org"
}
```

Set as an environment variable:
```bash
npx wrangler secret put ORG_MAPPINGS
# Enter: {"2365501087": "my-org", "2365501088": "client-org"}
```

**Finding Todoist Project IDs:**
1. Open Todoist web app
2. Navigate to the parent project
3. The URL will be `https://todoist.com/app/project/PROJECT_ID`

## Architecture

Single-file worker (`src/worker.js`) with the following HTTP routes:
- `GET /health` - Health check endpoint
- `GET /sync-status` - Returns polling sync status and health information
- `POST /backfill` - Backfill existing GitHub issues to Todoist (requires Bearer auth)
- `GET /api-docs` - Swagger UI documentation interface
- `GET /openapi.json` - OpenAPI 3.0 specification
- `GET /` - Redirects to `/api-docs`

### Polling-Based Sync

Uses Cloudflare Cron Triggers to poll both platforms every 15 minutes. This approach is reliable, self-healing, and requires no external webhook configuration.

**How it works:**
- Cron trigger fires every 15 minutes
- Fetches Todoist project hierarchy to determine which repos to sync (based on `ORG_MAPPINGS`)
- Polls GitHub for issues updated since last sync (using `since` parameter)
- Polls Todoist using Sync API with incremental `sync_token`
- Reconciles state between both platforms:
  - GitHub issues → Todoist tasks (created in the correct sub-project)
  - Todoist tasks → GitHub issues (using project hierarchy to determine org/repo)
- Saves sync state (timestamps, sync token) to KV store

**Sync state stored in KV (`sync:state`):**
```json
{
  "lastGitHubSync": "2024-01-15T10:30:00Z",
  "todoistSyncToken": "VRyFHa...",
  "lastPollTime": "2024-01-15T10:30:00Z",
  "pollCount": 42
}
```

**Check sync status:**
```bash
curl https://your-worker.workers.dev/sync-status
```

### Key Flows

1. Worker fetches all issues updated since last sync from GitHub
2. For each open issue without a Todoist task, creates a task in the appropriate sub-project
3. For closed issues, completes the corresponding Todoist task
4. Worker fetches changed tasks from Todoist via Sync API
5. For new tasks without GitHub URLs, creates GitHub issues in the appropriate repo
6. For completed tasks with GitHub URLs, closes the corresponding GitHub issue
7. For reopened tasks, reopens the corresponding GitHub issue

### Features

- **Full bidirectional sync**: Create, close, and reopen issues/tasks from either platform
- **Project-based repo routing**: Uses Todoist project hierarchy to determine GitHub org/repo
  - Parent projects map to GitHub organizations
  - Sub-projects map to repository names
  - Supports multiple organizations via `ORG_MAPPINGS`
- **Duplicate prevention**: Checks existing tasks before creating new ones
- **Loop prevention**: Tasks with GitHub URLs in description won't create new issues
- **Retry logic**: Exponential backoff for transient API failures
- **Efficient queries**: Uses Todoist Sync API with incremental sync tokens

### Backfill Endpoint

The `/backfill` endpoint syncs existing GitHub issues to Todoist. Authentication uses Bearer token (set `BACKFILL_SECRET`).

**Request:**
```bash
# Backfill all repos from Todoist project hierarchy (recommended)
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "projects", "dryRun": true}'

# Backfill single repo (open issues only)
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "single-repo", "repo": "my-repo", "owner": "my-org"}'

# Backfill entire org
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "org", "owner": "my-org", "state": "open"}'
```

**Parameters:**
- `mode`: `"projects"` (recommended), `"single-repo"`, or `"org"` (required)
- `repo`: Repository name (required for single-repo mode)
- `owner`: GitHub owner/org (required for single-repo and org modes)
- `state`: `"open"`, `"closed"`, or `"all"` (default: `"open"`)
- `dryRun`: `true` to preview without creating tasks (default: `false`)
- `limit`: Max issues to process per repo (optional)

**Modes:**
- `"projects"` - **Recommended.** Uses your Todoist project hierarchy to determine which repos to sync. Tasks are created in the correct sub-projects.
- `"single-repo"` - Backfill a specific repo (requires `repo` and `owner`)
- `"org"` - Backfill all repos in an org (requires `owner`)

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
- `test/parsing.test.js` - URL and label parsing tests
- `test/backfill.test.js` - Backfill endpoint tests
- `test/polling.test.js` - Polling sync, scheduled handler, and project hierarchy tests

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
| `KV_NAMESPACE_ID` | The KV namespace ID for sync state |
| `WORKER_GITHUB_TOKEN` | GitHub PAT for creating/updating issues |
| `TODOIST_API_TOKEN` | Todoist API token |
| `ORG_MAPPINGS` | JSON mapping Todoist parent project IDs to GitHub orgs (e.g., `{"123": "my-org"}`) |
| `BACKFILL_SECRET` | Secret for backfill endpoint auth |

3. Create the KV namespace (if not already created):
```bash
npx wrangler kv:namespace create "WEBHOOK_CACHE"
# Copy the ID to KV_NAMESPACE_ID secret
```

4. Create a Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens with:
   - Account: Workers Scripts: Edit
   - Account: Workers KV Storage: Edit
