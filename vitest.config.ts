import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "tests/integration/**"],
    environment: "node",
    testTimeout: 15_000,
  },
});
