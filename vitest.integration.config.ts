import { defineConfig } from "vitest/config";

/**
 * Integration tests need a real Herdr, so they are excluded from `npm test` and
 * run one file at a time — each file owns an isolated named Herdr session, and
 * concurrent servers would race on `herdr session list`.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts", "tests/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
