# GitHub ↔ Todoist Sync

A Cloudflare Worker that provides **full bidirectional synchronization** between GitHub issues and Todoist tasks. Create issues or tasks on either platform and they stay in sync automatically.

## Features

| GitHub Action | Todoist Result |
|---------------|----------------|
| Issue opened | Task created |
| Issue closed | Task completed |
| Issue edited | Task title updated |
| Issue reopened | Task reopened |

| Todoist Action | GitHub Result |
|----------------|---------------|
| Task created (with repo label) | Issue created |
| Task completed | Issue closed |
| Task updated | Issue title updated |
| Task uncompleted | Issue reopened |

**Additional features:**

- **Label-based repo routing** - Create tasks in Todoist with a label matching a repo name (e.g., `my-repo` or `owner/repo`) to create issues in the correct repository
- **Duplicate prevention** - Checks for existing tasks before creating new ones
- **Loop prevention** - Tasks created from GitHub won't create duplicate issues
- **Idempotency** - Uses KV store to prevent duplicate webhook processing
- **Retry logic** - Exponential backoff for transient API failures
- **Backfill endpoint** - Sync existing GitHub issues to Todoist

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

### 3. Configure secrets

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET    # Random string for webhook verification
npx wrangler secret put GITHUB_TOKEN             # GitHub PAT with repo scope
npx wrangler secret put TODOIST_API_TOKEN        # From Todoist Settings > Integrations
npx wrangler secret put TODOIST_WEBHOOK_SECRET   # Random string for webhook verification
npx wrangler secret put TODOIST_PROJECT_ID       # Target project ID
npx wrangler secret put GITHUB_ORG               # Default org/user for Todoist→GitHub sync
```

### 4. Deploy

```bash
npm run deploy
```

### 5. Configure webhooks

**GitHub webhook:**

1. Go to your repo or org settings → Webhooks → Add webhook
2. Payload URL: `https://your-worker.workers.dev/github-webhook`
3. Content type: `application/json`
4. Secret: Same value as `GITHUB_WEBHOOK_SECRET`
5. Events: Select "Issues"

**Todoist webhook:**

1. Go to [Todoist App Management](https://developer.todoist.com/appconsole.html)
2. Create a new app or use an existing one
3. Set webhook URL: `https://your-worker.workers.dev/todoist-webhook`
4. Note the client secret and use it for `TODOIST_WEBHOOK_SECRET`
5. Subscribe to: `item:added`, `item:completed`, `item:updated`, `item:uncompleted`

## Configuration

### Required secrets

| Secret | Description |
|--------|-------------|
| `GITHUB_WEBHOOK_SECRET` | Secret for GitHub webhook signature verification |
| `GITHUB_TOKEN` | GitHub Personal Access Token with `repo` scope |
| `TODOIST_API_TOKEN` | Todoist API token from Settings → Integrations → Developer |
| `TODOIST_WEBHOOK_SECRET` | Todoist app client secret for webhook verification |
| `TODOIST_PROJECT_ID` | ID of the Todoist project to sync with |

### Optional secrets

| Secret | Description |
|--------|-------------|
| `GITHUB_ORG` | Default GitHub owner for Todoist→GitHub sync |
| `BACKFILL_SECRET` | Auth token for backfill endpoint (falls back to `GITHUB_WEBHOOK_SECRET`) |

### Finding your Todoist project ID

1. Open Todoist in a web browser
2. Navigate to the project you want to sync
3. Copy the project ID from the URL: `https://todoist.com/app/project/PROJECT_ID`

## API Endpoints

### `POST /github-webhook`

Receives GitHub issue events. Automatically called by GitHub when issues are created, closed, edited, or reopened.

**Headers:**
- `X-GitHub-Event`: Event type
- `X-Hub-Signature-256`: HMAC-SHA256 signature
- `X-GitHub-Delivery`: Unique delivery ID

### `POST /todoist-webhook`

Receives Todoist task events. Automatically called by Todoist when tasks are added, completed, updated, or uncompleted.

**Headers:**
- `X-Todoist-Hmac-SHA256`: Base64-encoded HMAC-SHA256 signature
- `X-Todoist-Delivery-ID`: Unique delivery ID

### `POST /backfill`

Sync existing GitHub issues to Todoist. Useful for initial setup or catching up after downtime.

**Authentication:** Bearer token (use `BACKFILL_SECRET` or `GITHUB_WEBHOOK_SECRET`)

**Request body:**

```json
{
  "mode": "single-repo",
  "repo": "my-repo",
  "owner": "my-org",
  "state": "open",
  "dryRun": false,
  "limit": 100
}
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `mode` | Yes | `"single-repo"` or `"org"` |
| `repo` | For single-repo | Repository name |
| `owner` | No | GitHub owner (defaults to `GITHUB_ORG`) |
| `state` | No | `"open"`, `"closed"`, or `"all"` (default: `"open"`) |
| `dryRun` | No | Preview without creating tasks (default: `false`) |
| `limit` | No | Max issues to process |

**Examples:**

```bash
# Dry-run for a single repo
curl -X POST https://your-worker.workers.dev/backfill \
  -H "Authorization: Bearer $BACKFILL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode": "single-repo", "repo": "my-repo", "dryRun": true}'

# Backfill all open issues from an org
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

## How It Works

### GitHub → Todoist

When a GitHub issue is created:
1. GitHub sends a webhook to `/github-webhook`
2. Worker verifies the signature and checks for duplicates
3. Creates a Todoist task with format: `[repo#123] Issue title`
4. Stores the GitHub issue URL in the task description

When an issue is closed/edited/reopened, the worker finds the corresponding task by matching the issue URL in task descriptions.

### Todoist → GitHub

When a Todoist task is created with a repo label:
1. Todoist sends a webhook to `/todoist-webhook`
2. Worker parses the label to determine the target repository
3. Creates a GitHub issue in that repository
4. Updates the task description with the new issue URL

Label formats:
- Simple: `my-repo` → uses `GITHUB_ORG/my-repo`
- Explicit: `owner/repo` → uses `owner/repo`

When a task is completed/updated/uncompleted, the worker parses the GitHub URL from the task description and updates the corresponding issue.

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
| `npm run test:coverage` | Run tests with coverage report |

### Project structure

```
github-todoist-sync/
├── src/
│   └── worker.js         # Main worker code (single file)
├── test/
│   ├── signature.test.js # Signature verification tests
│   ├── parsing.test.js   # URL and label parsing tests
│   ├── webhook.test.js   # Webhook handler tests
│   └── backfill.test.js  # Backfill endpoint tests
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
- GitHub signature verification
- Todoist signature verification
- URL and label parsing
- Webhook event handling
- Backfill endpoint validation

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
| `WORKER_GITHUB_WEBHOOK_SECRET` | GitHub webhook secret |
| `WORKER_GITHUB_TOKEN` | GitHub PAT for API access |
| `TODOIST_API_TOKEN` | Todoist API token |
| `TODOIST_WEBHOOK_SECRET` | Todoist webhook secret |
| `TODOIST_PROJECT_ID` | Target Todoist project ID |
| `GITHUB_ORG` | Default GitHub org (optional) |
| `BACKFILL_SECRET` | Backfill auth token (optional) |

## Task Format

Tasks created in Todoist follow this format:

```
[repo-name#123] Issue title here
```

The task description contains the full GitHub issue URL:

```
https://github.com/owner/repo/issues/123
```

This format enables:
- Quick identification of the source repository
- Direct linking to the GitHub issue
- Bidirectional sync through URL matching

## Troubleshooting

### Webhook not triggering

1. Check the webhook delivery logs in GitHub/Todoist
2. Verify secrets match between services
3. Check worker logs: `npm run tail`

### Tasks not being created

1. Verify `TODOIST_PROJECT_ID` is correct
2. Check if task already exists (duplicate prevention)
3. Ensure GitHub issue events are selected in webhook config

### Issues not being created from Todoist

1. Add a repo label to the task (e.g., `my-repo` or `org/repo`)
2. Ensure `GITHUB_ORG` is set if using simple repo labels
3. Verify `GITHUB_TOKEN` has `repo` scope

### Rate limiting

The backfill endpoint includes rate limiting:
- GitHub: 60 requests/minute
- Todoist: 300 requests/minute

For large backfills, tasks are processed with automatic delays to stay within limits.

## Security

- All webhook payloads are verified using HMAC-SHA256 signatures
- Signature comparison uses timing-safe equality checks
- Secrets are stored securely in Cloudflare Workers
- KV store prevents replay attacks through idempotency

## License

MIT
