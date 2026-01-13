import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          kvNamespaces: ["WEBHOOK_CACHE"],
          bindings: {
            GITHUB_WEBHOOK_SECRET: "test-github-secret",
            GITHUB_TOKEN: "test-github-token",
            TODOIST_API_TOKEN: "test-todoist-token",
            TODOIST_WEBHOOK_SECRET: "test-todoist-secret",
            TODOIST_PROJECT_ID: "123456",
            GITHUB_ORG: "test-org",
            BACKFILL_SECRET: "test-backfill-secret",
          },
        },
      },
    },
  },
});
