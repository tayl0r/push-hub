import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    clearMocks: true,                       // reset every mock's call history before each test — zero-call assertions must not depend on test order
    fileParallelism: false,                 // DB test files share one push_tokens table + TRUNCATE between cases — serialize files so they can't race
    globalSetup: './test/global-setup.ts',  // migrate TEST_DATABASE_URL once before any suite (fails when unset)
    setupFiles: ['./test/setup.ts'],        // per-file hooks: zero metric values before every test
  },
})
