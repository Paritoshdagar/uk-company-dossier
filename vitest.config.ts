import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    mockReset: true,
    passWithNoTests: false,
    restoreMocks: true,
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
