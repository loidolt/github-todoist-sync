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
- `POST /reset-projects` - Reset known projects to trigger auto-backfill on next sync (requires Bearer auth)
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
  "pollCount": 42,
  "knownProjectIds": ["1001", "1002"],
  "forceBackfillNextSync": false,
  "forceBackfillProjectIds": []
}
```

The `forceBackfillNextSync` and `forceBackfillProjectIds` fields are set by the `/reset-projects` endpoint to trigger backfill on the next sync cycle.

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
- **Milestone/Section sync**: GitHub milestones map bidirectionally to Todoist sections
  - Issues with milestones → tasks placed in sections named after the milestone
  - Tasks in sections → issues created with matching milestone
  - Milestone changes on GitHub → task moves to new section
  - Section changes in Todoist → issue milestone updated
  - Issues without milestones stay outside any section
- **Auto-backfill for new projects**: When you add a new sub-project in Todoist, the next sync automatically backfills all open GitHub issues from that repo. Simply add a sub-project named after your repo and issues will be synced on the next cycle.
- **Duplicate prevention**: Checks existing tasks before creating new ones (uses batch API calls for efficiency)
- **Loop prevention**: Tasks with GitHub URLs in description won't create new issues
- **Retry logic**: Exponential backoff for transient API failures
- **Efficient queries**: Uses Todoist Sync API with incremental sync tokens and batch task fetching

### Milestone to Section Mapping

GitHub milestones are automatically synced to Todoist sections within sub-projects:

**How it works:**
- When a GitHub issue has a milestone (e.g., "v1.0"), the corresponding Todoist task is placed in a section named "v1.0"
- If the section doesn't exist, it's automatically created
- When the milestone changes, the task is moved to the new section
- When a Todoist task is created in a section, the GitHub issue is created with the matching milestone (if it exists in the repo)
- Tasks/issues without milestones/sections stay in the default area (outside any section)

**Example:**
```
GitHub Repo: my-org/api
├── Issue #1 "Fix bug" (milestone: v1.0)
├── Issue #2 "Add feature" (milestone: v2.0)
└── Issue #3 "Update docs" (no milestone)

Todoist Sub-Project: api
├── Section: v1.0
│   └── [#1] Fix bug
├── Section: v2.0
│   └── [#2] Add feature
└── (no section)
    └── [#3] Update docs
```

**Notes:**
- Section names match milestone titles exactly (case-sensitive)
- Milestones must exist in GitHub before they can be assigned via Todoist sections
- Sections are created automatically when needed, but milestones are NOT auto-created

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
- `"projects"` - **Recommended.** Uses your Todoist project hierarchy to determine which repos to sync. Tasks are created in the correct sub-projects. Required for actual task creation.
- `"single-repo"` - Preview issues in a specific repo (requires `repo` and `owner`). Best used with `dryRun: true` for discovery.
- `"org"` - Preview issues in all repos of an org (requires `owner`). Best used with `dryRun: true` for discovery.

**Note:** Only `"projects"` mode can create tasks because it knows which Todoist sub-project to use for each repo. Use `single-repo` and `org` modes with `dryRun: true` to preview which issues would be synced.

**Response:** Streaming NDJSON with real-time progress:
```json
{"type": "start", "totalRepos": 1, "dryRun": true}
{"type": "issue", "repo": "owner/repo", "issue": 1, "title": "...", "status": "would_create"}
{"type": "issue", "repo": "owner/repo", "issue": 2, "title": "...", "status": "skipped", "reason": "already_exists"}
{"type": "repo_complete", "repo": "owner/repo", "issues": 2}
{"type": "complete", "summary": {"total": 2, "created": 1, "skipped": 1, "failed": 0}}
```

### Reset Projects Endpoint

The `/reset-projects` endpoint resets the known projects list to trigger auto-backfill on the next sync. This is useful when you want to re-backfill existing repos without adding new sub-projects. Authentication uses Bearer token (same as backfill).

**Request:**
```bash
# Preview what would be reset (dry run)
curl -X POST https://your-worker.workers.dev/reset-projects \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "all", "dryRun": true}'

# Reset all projects - triggers backfill for all repos on next sync
curl -X POST https://your-worker.workers.dev/reset-projects \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "all"}'

# Reset specific projects only
curl -X POST https://your-worker.workers.dev/reset-projects \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "specific", "projectIds": ["1001", "1002"]}'
```

**Parameters:**
- `mode`: `"all"` or `"specific"` (default: `"all"`)
- `projectIds`: Array of project IDs to reset (required for `"specific"` mode)
- `dryRun`: `true` to preview without making changes (default: `false`)

**Response:**
```json
{
  "success": true,
  "message": "Reset 3 project(s). They will be auto-backfilled on the next sync.",
  "resetProjects": [
    {"id": "1001", "name": "api", "repo": "my-org/api"},
    {"id": "1002", "name": "web", "repo": "my-org/web"}
  ],
  "remainingKnownProjects": [],
  "nextSyncWillBackfill": 2
}
```

**How it works:**
1. The endpoint sets a `forceBackfillNextSync` flag in the sync state
2. On the next scheduled sync (within 15 minutes), the worker detects this flag
3. All reset projects are auto-backfilled (open issues synced to Todoist)
4. The flag is automatically cleared after the sync completes

**Use cases:**
- Re-sync all issues after making changes to existing tasks
- Recover from a failed or incomplete initial backfill
- Force a fresh sync without waiting for new projects to be detected

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

## Troubleshooting

### Todoist Task Completion Not Closing GitHub Issues

If completing tasks in Todoist doesn't close the corresponding GitHub issues, check the following:

**1. Check if KV mappings exist**

The system uses KV mappings (`task:{taskId}` → GitHub URL) to resolve which GitHub issue to close. Run the `create-mappings` backfill to ensure mappings exist:

```bash
# Preview what mappings would be created
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "create-mappings", "dryRun": true}'

# Actually create the mappings
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "create-mappings"}'
```

**2. Check sync logs**

Use `npm run tail` to stream live logs and look for:
- `Could not resolve GitHub URL for completed task` - URL resolution failed for a task
- `[CRITICAL] Failed to store KV mapping` - KV write failed during task creation

**3. URL Resolution Fallback Layers**

When a task is completed, the system tries 4 methods to find the GitHub URL:
1. **KV mapping** (fastest) - looks up `task:{taskId}` in KV
2. **Task description** - parses GitHub URL from the completed task's description
3. **Content parsing** - extracts issue number from `[#123]` prefix + uses project hierarchy
4. **REST API fetch** - fetches task details (doesn't work for completed tasks)

If all 4 layers fail, the task is skipped but will be retried on the next sync.

**4. Common causes**
- Tasks created before the KV mapping feature was added
- Tasks created directly in Todoist (not synced from GitHub)
- Tasks with modified content that lost the `[#N]` prefix
- Tasks in projects not in `ORG_MAPPINGS`

### Sync State Issues

If sync appears stuck or missing data:

```bash
# Check current sync state
curl https://your-worker.workers.dev/sync-status

# Force a reset of the completed tasks sync point
# (This will re-process recent completed tasks)
npx wrangler kv:key get --binding=WEBHOOK_CACHE "sync:state"
```

To manually reset `lastCompletedSync`:
```bash
# Get current state, modify lastCompletedSync to null, then put back
npx wrangler kv:key put --binding=WEBHOOK_CACHE "sync:state" '{"lastGitHubSync":"...", "lastCompletedSync":null, ...}'
```
