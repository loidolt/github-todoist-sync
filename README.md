# GitHub ↔ Todoist Sync

A Cloudflare Worker that provides **bidirectional synchronization** between GitHub issues and Todoist tasks using polling-based sync. No webhooks required - sync runs automatically every 15 minutes.

## Features

| GitHub Action | Todoist Result |
|---------------|----------------|
| Issue opened | Task created in sub-project |
| Issue closed | Task completed |
| Issue reopened | Task reopened |

| Todoist Action | GitHub Result |
|----------------|---------------|
| Task created (in sub-project) | Issue created in corresponding repo |
| Task completed | Issue closed |
| Task uncompleted | Issue reopened |

**Additional features:**

- **Project-based repo routing** - Use Todoist project hierarchy to define which repos to sync
- **Multi-org support** - Map multiple Todoist parent projects to different GitHub organizations
- **Duplicate prevention** - Checks for existing tasks before creating new ones
- **Loop prevention** - Tasks created from GitHub won't create duplicate issues
- **Retry logic** - Exponential backoff for transient API failures
- **Backfill endpoint** - Sync existing GitHub issues to Todoist

## How It Works

The sync uses Todoist's project hierarchy to determine which GitHub repos to sync:

```
Issues (parent project)           → maps to "my-org" GitHub org
├── api                          → syncs with my-org/api
├── web-app                      → syncs with my-org/web-app
└── docs                         → syncs with my-org/docs

Client Projects (parent project)  → maps to "client-org" GitHub org
├── project-a                    → syncs with client-org/project-a
└── project-b                    → syncs with client-org/project-b
```

Every 15 minutes, the worker:
1. Fetches your Todoist project hierarchy
2. Polls GitHub for issues updated since last sync
3. Creates/updates/completes Todoist tasks as needed
4. Polls Todoist for changed tasks
5. Creates/closes/reopens GitHub issues as needed

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- GitHub account with access to target repositories
- [Todoist account](https://todoist.com/) with API access

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/github-todoist-sync.git
cd github-todoist-sync
npm install
```

### 2. Create KV namespace

```bash
npx wrangler kv:namespace create "WEBHOOK_CACHE"
```

Copy the `id` from the output and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "WEBHOOK_CACHE"
id = "your-kv-namespace-id"
```

### 3. Set up Todoist project structure

Create your project hierarchy in Todoist:

1. Create a parent project (e.g., "Issues" or "Work")
2. Create sub-projects for each repo you want to sync (e.g., "api", "web-app")
3. Note the parent project ID from the URL: `https://todoist.com/app/project/PROJECT_ID`

### 4. Configure secrets

```bash
npx wrangler secret put GITHUB_TOKEN        # GitHub PAT with repo scope
npx wrangler secret put TODOIST_API_TOKEN   # From Todoist Settings > Integrations > Developer
npx wrangler secret put ORG_MAPPINGS        # JSON mapping project IDs to GitHub orgs
npx wrangler secret put BACKFILL_SECRET     # Random string for backfill endpoint auth
```

For `ORG_MAPPINGS`, enter a JSON object mapping Todoist parent project IDs to GitHub organizations:

```json
{"2365501087": "my-org", "2365501088": "client-org"}
```

### 5. Deploy

```bash
npm run deploy
```

That's it! The worker will automatically sync every 15 minutes via Cloudflare Cron Triggers.

## Configuration

### Required secrets

| Secret | Description |
|--------|-------------|
| `GITHUB_TOKEN` | GitHub Personal Access Token with `repo` scope |
| `TODOIST_API_TOKEN` | Todoist API token from Settings → Integrations → Developer |
| `ORG_MAPPINGS` | JSON mapping Todoist parent project IDs to GitHub orgs |

### Optional secrets

| Secret | Description |
|--------|-------------|
| `BACKFILL_SECRET` | Auth token for backfill endpoint |

### Finding Todoist project IDs

1. Open Todoist in a web browser
2. Navigate to the parent project you want to map
3. Copy the project ID from the URL: `https://todoist.com/app/project/PROJECT_ID`

## API Endpoints

### `GET /sync-status`

Check the sync status and health.

**Response:**

```json
{
  "status": "ok",
  "lastSync": "2024-01-15T10:30:00.000Z",
  "pollCount": 42,
  "nextSync": "in 15 minutes"
}
```

### `POST /backfill`

Sync existing GitHub issues to Todoist. Useful for initial setup.

**Authentication:** Bearer token (use `BACKFILL_SECRET`)

**Request body:**

```json
{
  "mode": "projects",
  "state": "open",
  "dryRun": false,
  "limit": 100
}
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `mode` | Yes | `"projects"` (recommended), `"single-repo"`, or `"org"` |
| `repo` | For single-repo | Repository name |
| `owner` | For single-repo/org | GitHub owner |
| `state` | No | `"open"`, `"closed"`, or `"all"` (default: `"open"`) |
| `dryRun` | No | Preview without creating tasks (default: `false`) |
| `limit` | No | Max issues to process per repo |

**Modes:**
- `"projects"` - **Recommended.** Uses your Todoist project hierarchy to determine which repos to sync. Tasks are created in the correct sub-projects.
- `"single-repo"` - Backfill a specific repo (requires `repo` and `owner`)
- `"org"` - Backfill all repos in an org (requires `owner`)

**Examples:**

```bash
# Backfill all repos from Todoist project hierarchy (recommended)
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "projects", "dryRun": true}'

# Backfill a single repo
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "single-repo", "repo": "my-repo", "owner": "my-org"}'

# Backfill all repos from a GitHub org
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "org", "owner": "my-org"}'
```

**Response:** Streaming NDJSON with real-time progress:

```json
{"type": "start", "totalRepos": 1, "dryRun": false}
{"type": "issue", "repo": "org/repo", "issue": 1, "title": "Bug fix", "status": "created", "taskId": "123"}
{"type": "issue", "repo": "org/repo", "issue": 2, "title": "Feature", "status": "skipped", "reason": "already_exists"}
{"type": "repo_complete", "repo": "org/repo", "issues": 2}
{"type": "complete", "summary": {"total": 2, "created": 1, "skipped": 1, "failed": 0}}
```

### `GET /health`

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### `GET /api-docs`

Interactive Swagger UI documentation.

### `GET /openapi.json`

OpenAPI 3.0 specification.

## Task Format

Tasks created in Todoist follow this format:

```
[#123] Issue title here
```

The task description contains the full GitHub issue URL:

```
https://github.com/owner/repo/issues/123
```

This format enables:
- Quick identification of the issue number (repo is determined by the project)
- Direct linking to the GitHub issue
- Bidirectional sync through URL matching

When you create a task in Todoist without a prefix and it syncs to GitHub, the prefix is automatically added after the GitHub issue is created.

## Development

### Local development

```bash
npm run dev
```

This starts a local development server with hot reloading.

### Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local development server |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run tail` | Stream live logs from deployed worker |
| `npm test` | Run tests with Vitest |

### Project structure

```
github-todoist-sync/
├── src/
│   └── worker.js         # Main worker code
├── test/
│   ├── parsing.test.js   # URL and label parsing tests
│   ├── backfill.test.js  # Backfill endpoint tests
│   └── polling.test.js   # Polling sync tests
├── .github/
│   └── workflows/
│       └── ci.yml        # CI/CD pipeline
├── wrangler.toml         # Cloudflare Workers config
├── vitest.config.ts      # Test configuration
└── package.json
```

## Testing

Tests are run using Vitest with the Cloudflare Workers test pool.

```bash
npm test
```

The test suite covers:
- URL and label parsing
- Backfill endpoint validation
- Polling sync and project hierarchy
- Task creation and completion flows

## CI/CD

Deployments are automated via GitHub Actions:

1. **Test job** - Runs on all pushes and pull requests
2. **Deploy job** - Runs on pushes to `main` after tests pass

### Setting up GitHub Actions

1. Create a `production` environment in your repo settings
2. Add the following secrets to the environment:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `KV_NAMESPACE_ID` | KV namespace ID from step 2 |
| `WORKER_GITHUB_TOKEN` | GitHub PAT for API access |
| `TODOIST_API_TOKEN` | Todoist API token |
| `ORG_MAPPINGS` | JSON mapping project IDs to GitHub orgs |
| `BACKFILL_SECRET` | Backfill auth token |

## Troubleshooting

### Sync not running

1. Check sync status: `curl https://your-worker.workers.dev/sync-status`
2. Verify cron trigger is configured in `wrangler.toml`
3. Check worker logs: `npm run tail`

### Tasks not being created

1. Verify `ORG_MAPPINGS` is correctly configured
2. Check if the repo has a corresponding sub-project in Todoist
3. Ensure the parent project ID in `ORG_MAPPINGS` is correct

### Issues not being created from Todoist

1. Ensure the task is in a sub-project (not the parent project)
2. Verify the sub-project name matches a valid GitHub repo
3. Verify `GITHUB_TOKEN` has `repo` scope

### Rate limiting

The backfill endpoint includes rate limiting:
- GitHub: 60 requests/minute
- Todoist: 300 requests/minute

For large backfills, tasks are processed with automatic delays to stay within limits.

## Security

- Backfill endpoint requires Bearer token authentication
- Secrets are stored securely in Cloudflare Workers
- GitHub token uses least-privilege `repo` scope

## License

MIT
