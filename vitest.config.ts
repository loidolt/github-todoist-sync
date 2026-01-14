import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          kvNamespaces: ["WEBHOOK_CACHE"],
          bindings: {
            GITHUB_TOKEN: "test-github-token",
            TODOIST_API_TOKEN: "test-todoist-token",
            BACKFILL_SECRET: "test-backfill-secret",
          },
        },
      },
    },
  },
});
