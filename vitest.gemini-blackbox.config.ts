import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.eval.ts"],
    testTimeout: 360_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
