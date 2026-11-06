import { defineConfig } from 'vitest/config';

// Live Sepolia and local-fork test files share one RPC provider: run files one at a time so they do not
// compete for its rate limit (tests inside a file still run in order).
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
