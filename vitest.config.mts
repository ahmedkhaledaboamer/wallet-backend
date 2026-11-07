import { defineConfig } from "vitest/config";

// Limited-RAM machine: at most 2 workers (Vitest 5 replaced poolOptions.maxThreads/maxForks with maxWorkers).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    pool: "threads",
    maxWorkers: 2,
    fileParallelism: true,
    testTimeout: 30_000,
  },
});
