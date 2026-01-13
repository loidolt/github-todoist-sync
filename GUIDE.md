# GitHub ↔ Todoist Sync Worker

A Cloudflare Worker that syncs GitHub issues to Todoist tasks and closes issues when tasks are completed.

## How It Works

1. **GitHub Issue Created** → Worker receives webhook → Creates Todoist task with issue URL in description
2. **Todoist Task Completed** → Worker receives webhook → Parses GitHub URL → Closes the issue

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A Cloudflare account
- A GitHub account with a repo you want to sync
- A Todoist account

---

## Step 1: Project Setup

```bash
# Create project directory
mkdir github-todoist-sync
cd github-todoist-sync

# Initialize the project
npm init -y
npm install wrangler --save-dev
```

---

## Step 2: Create Project Files

### `wrangler.toml`

```toml
name = "github-todoist-sync"
main = "src/worker.js"
compatibility_date = "2024-01-01"

[vars]
# Non-secret config goes here
# TODOIST_PROJECT_ID = "your-project-id"  # Can also be a secret if preferred

# Secrets are added via `wrangler secret put <NAME>`
# Required secrets:
# - GITHUB_WEBHOOK_SECRET
# - GITHUB_TOKEN
# - TODOIST_API_TOKEN
# - TODOIST_WEBHOOK_SECRET
# - TODOIST_PROJECT_ID
```

### `src/worker.js`

```javascript
/**
 * GitHub ↔ Todoist Sync Worker
 * 
 * Routes:
 *   POST /github-webhook   - Receives GitHub issue events, creates Todoist tasks
 *   POST /todoist-webhook  - Receives Todoist completion events, closes GitHub issues
 *   GET  /health           - Health check endpoint
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Route requests
    if (request.method === 'POST' && url.pathname === '/github-webhook') {
      return handleGitHubWebhook(request, env);
    }
    
    if (request.method === 'POST' && url.pathname === '/todoist-webhook') {
      return handleTodoistWebhook(request, env);
    }
    
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

// =============================================================================
// GitHub Webhook Handler
// =============================================================================

async function handleGitHubWebhook(request, env) {
  const body = await request.text();
  
  // Validate signature
  const signature = request.headers.get('X-Hub-Signature-256');
  if (!signature || !(await verifyGitHubSignature(body, signature, env.GITHUB_WEBHOOK_SECRET))) {
    console.error('GitHub webhook signature validation failed');
    return new Response('Unauthorized', { status: 401 });
  }
  
  const event = request.headers.get('X-GitHub-Event');
  const payload = JSON.parse(body);
  
  // Only handle issue opened events
  if (event !== 'issues' || payload.action !== 'opened') {
    return new Response(JSON.stringify({ message: 'Event ignored', event, action: payload.action }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const issue = payload.issue;
  const repo = payload.repository;
  
  console.log(`Processing new issue: ${repo.full_name}#${issue.number} - ${issue.title}`);
  
  // Optional: Filter by repo, label, or assignee
  // if (!shouldSyncIssue(issue, repo, env)) {
  //   return new Response(JSON.stringify({ message: 'Issue filtered out' }), { status: 200 });
  // }
  
  try {
    const task = await createTodoistTask(env, {
      title: issue.title,
      issueNumber: issue.number,
      repoName: repo.name,
      repoFullName: repo.full_name,
      issueUrl: issue.html_url,
      labels: issue.labels?.map(l => l.name) || [],
    });
    
    console.log(`Created Todoist task: ${task.id}`);
    
    return new Response(JSON.stringify({ 
      message: 'Task created',
      taskId: task.id,
      issue: `${repo.full_name}#${issue.number}`
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Failed to create Todoist task:', error);
    return new Response(JSON.stringify({ error: 'Failed to create task', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function createTodoistTask(env, { title, issueNumber, repoName, repoFullName, issueUrl, labels }) {
  const response = await fetch('https://api.todoist.com/rest/v2/tasks', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.TODOIST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: `[${repoName}#${issueNumber}] ${title}`,
      description: issueUrl,
      project_id: env.TODOIST_PROJECT_ID,
      // Optional: Map GitHub labels to Todoist labels
      // labels: mapLabels(labels),
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Todoist API error: ${response.status} - ${errorText}`);
  }
  
  return response.json();
}

// =============================================================================
// Todoist Webhook Handler
// =============================================================================

async function handleTodoistWebhook(request, env) {
  const body = await request.text();
  
  // Validate signature
  const signature = request.headers.get('X-Todoist-Hmac-SHA256');
  if (!signature || !(await verifyTodoistSignature(body, signature, env.TODOIST_WEBHOOK_SECRET))) {
    console.error('Todoist webhook signature validation failed');
    return new Response('Unauthorized', { status: 401 });
  }
  
  const payload = JSON.parse(body);
  
  // Only handle item:completed events
  if (payload.event_name !== 'item:completed') {
    return new Response(JSON.stringify({ message: 'Event ignored', event: payload.event_name }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const task = payload.event_data;
  console.log(`Processing completed task: ${task.id} - ${task.content}`);
  
  // Extract GitHub URL from task description
  const githubInfo = parseGitHubUrl(task.description);
  
  if (!githubInfo) {
    console.log('No GitHub URL found in task description, skipping');
    return new Response(JSON.stringify({ message: 'No GitHub URL in task, skipped' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  console.log(`Closing GitHub issue: ${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`);
  
  try {
    await closeGitHubIssue(env, githubInfo);
    
    return new Response(JSON.stringify({
      message: 'Issue closed',
      issue: `${githubInfo.owner}/${githubInfo.repo}#${githubInfo.issueNumber}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Failed to close GitHub issue:', error);
    return new Response(JSON.stringify({ error: 'Failed to close issue', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function parseGitHubUrl(description) {
  if (!description) return null;
  
  // Match: https://github.com/{owner}/{repo}/issues/{number}
  const match = description.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  
  if (!match) return null;
  
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10),
  };
}

async function closeGitHubIssue(env, { owner, repo, issueNumber }) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'GitHub-Todoist-Sync-Worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: 'closed',
        state_reason: 'completed',
      }),
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
  }
  
  return response.json();
}

// =============================================================================
// Signature Verification
// =============================================================================

async function verifyGitHubSignature(payload, signature, secret) {
  // GitHub sends: sha256=<hex-digest>
  const expectedSig = signature.replace('sha256=', '');
  const computed = await hmacSha256Hex(payload, secret);
  return timingSafeEqual(expectedSig, computed);
}

async function verifyTodoistSignature(payload, signature, secret) {
  // Todoist sends: base64-encoded HMAC-SHA256
  const computed = await hmacSha256Base64(payload, secret);
  return timingSafeEqual(signature, computed);
}

async function hmacSha256Hex(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256Base64(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
```

### `package.json`

```json
{
  "name": "github-todoist-sync",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail"
  },
  "devDependencies": {
    "wrangler": "^3.0.0"
  }
}
```

---

## Step 3: Get Your API Tokens and IDs

### GitHub Personal Access Token

1. Go to [GitHub Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta)
2. Click "Generate new token"
3. Configure:
   - **Name**: `todoist-sync`
   - **Expiration**: Set as needed (or no expiration)
   - **Repository access**: Select specific repos you want to sync
   - **Permissions**: 
     - Issues: Read and write
4. Copy the token (starts with `github_pat_`)

### Todoist API Token

1. Go to [Todoist Settings → Integrations → Developer](https://todoist.com/app/settings/integrations/developer)
2. Copy your API token

### Todoist Project ID

1. Open Todoist in your browser
2. Navigate to the project you want tasks created in
3. The URL will be: `https://todoist.com/app/project/XXXXXXXXXX`
4. Copy the number — that's your project ID

### Generate Webhook Secrets

Generate two random secrets for webhook validation:

```bash
# Generate random secrets (run these and save the output)
openssl rand -hex 32  # For GITHUB_WEBHOOK_SECRET
openssl rand -hex 32  # For TODOIST_WEBHOOK_SECRET
```

---

## Step 4: Deploy the Worker

### Login to Cloudflare

```bash
npx wrangler login
```

### Add Secrets

```bash
# Add each secret (you'll be prompted to enter the value)
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TODOIST_API_TOKEN
npx wrangler secret put TODOIST_WEBHOOK_SECRET
npx wrangler secret put TODOIST_PROJECT_ID
```

### Deploy

```bash
npm run deploy
```

Note your worker URL: `https://github-todoist-sync.<your-subdomain>.workers.dev`

---

## Step 5: Configure GitHub Webhook

1. Go to your repository → **Settings** → **Webhooks** → **Add webhook**
   - Or for org-wide: Organization Settings → Webhooks

2. Configure:
   - **Payload URL**: `https://github-todoist-sync.<your-subdomain>.workers.dev/github-webhook`
   - **Content type**: `application/json`
   - **Secret**: The value you used for `GITHUB_WEBHOOK_SECRET`
   - **SSL verification**: Enable
   - **Events**: Select "Let me select individual events" → check only **Issues**

3. Click "Add webhook"

4. GitHub will send a ping — check the "Recent Deliveries" tab to confirm it worked

---

## Step 6: Configure Todoist Webhook

Todoist webhooks require creating an "App" in their developer console.

### Create a Todoist App

1. Go to [Todoist App Management Console](https://developer.todoist.com/appconsole.html)
2. Click "Create a new app"
3. Configure:
   - **App name**: `GitHub Sync` (or whatever you like)
   - **App service URL**: `https://github-todoist-sync.<your-subdomain>.workers.dev`

### Configure the Webhook

1. In your app settings, find the **Webhooks** section
2. Add webhook:
   - **Webhook URL**: `https://github-todoist-sync.<your-subdomain>.workers.dev/todoist-webhook`
   - **Events**: Select `item:completed`
3. Note the **Client secret** shown in your app settings — this is your `TODOIST_WEBHOOK_SECRET`
   - **Important**: If you already set a different secret, update it:
     ```bash
     npx wrangler secret put TODOIST_WEBHOOK_SECRET
     # Enter the Client secret from Todoist
     ```

### Activate the Webhook

1. In the Todoist App Console, you may need to "Test" or "Activate" the webhook
2. Todoist will send a verification request to your endpoint

---

## Step 7: Test the Integration

### Test GitHub → Todoist

1. Create a new issue in your connected repository
2. Check Todoist — a new task should appear in your target project
3. The task description should contain the GitHub issue URL

### Test Todoist → GitHub

1. Complete the task you just created in Todoist
2. Check GitHub — the issue should now be closed

### Debug with Logs

```bash
# Stream live logs from your worker
npm run tail
```

### Manual Testing

```bash
# Test health endpoint
curl https://github-todoist-sync.<your-subdomain>.workers.dev/health
```

---

## Optional Enhancements

### Filter Issues by Label or Repo

Add filtering logic to only sync certain issues:

```javascript
function shouldSyncIssue(issue, repo, env) {
  // Only sync issues from specific repos
  const allowedRepos = ['my-repo', 'another-repo'];
  if (!allowedRepos.includes(repo.name)) {
    return false;
  }
  
  // Only sync issues with specific labels
  const syncLabels = ['todo', 'task'];
  const hasLabel = issue.labels?.some(l => syncLabels.includes(l.name));
  if (!hasLabel) {
    return false;
  }
  
  return true;
}
```

### Add Priority Mapping

Map GitHub labels to Todoist priorities:

```javascript
function getPriority(labels) {
  if (labels.includes('urgent') || labels.includes('critical')) return 4;
  if (labels.includes('high')) return 3;
  if (labels.includes('medium')) return 2;
  return 1; // Default (normal)
}
```

### Duplicate Prevention

Check if a task already exists before creating:

```javascript
async function taskExists(env, issueUrl) {
  // Search for tasks with this URL in description
  const response = await fetch(
    `https://api.todoist.com/rest/v2/tasks?project_id=${env.TODOIST_PROJECT_ID}`,
    {
      headers: { 'Authorization': `Bearer ${env.TODOIST_API_TOKEN}` }
    }
  );
  
  const tasks = await response.json();
  return tasks.some(t => t.description?.includes(issueUrl));
}
```

### Handle Issue Reopening

Add support for `reopened` events to uncomplete Todoist tasks (note: Todoist API doesn't easily support this, so you might create a new task instead).

---

## Troubleshooting

### Webhook signature validation failing

- Ensure the secret in GitHub/Todoist matches exactly what you set via `wrangler secret put`
- Check for trailing whitespace or newlines
- Use `npm run tail` to see the actual error

### Tasks not being created

- Check GitHub webhook "Recent Deliveries" for errors
- Verify your `TODOIST_PROJECT_ID` is correct
- Ensure your Todoist API token has write access

### Issues not closing

- Verify your GitHub token has `issues: write` permission on the repo
- Check that the task description contains a valid GitHub issue URL
- Look at worker logs with `npm run tail`

### Todoist webhook not firing

- Ensure the app is "activated" in the Todoist App Console
- Verify the webhook URL is correct and accessible
- Check that you've subscribed to `item:completed` events

---

## File Structure

```
github-todoist-sync/
├── src/
│   └── worker.js      # Main worker code
├── package.json
├── wrangler.toml      # Cloudflare Worker config
└── GUIDE.md           # This file
```

---

## Quick Reference

| Secret | Source |
|--------|--------|
| `GITHUB_WEBHOOK_SECRET` | You generate (random string) |
| `GITHUB_TOKEN` | GitHub → Settings → Developer → PAT |
| `TODOIST_API_TOKEN` | Todoist → Settings → Integrations → Developer |
| `TODOIST_WEBHOOK_SECRET` | Todoist App Console → Your App → Client Secret |
| `TODOIST_PROJECT_ID` | From Todoist project URL |

| Endpoint | Purpose |
|----------|---------|
| `POST /github-webhook` | Receives GitHub issue events |
| `POST /todoist-webhook` | Receives Todoist task completion events |
| `GET /health` | Health check |
