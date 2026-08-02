import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    // The security/git-fixture suites spawn many real `git` subprocesses per
    // test; under full-suite parallelism (many files/workers spawning git at
    // once) that can comfortably exceed vitest's 5s default, especially on
    // slower filesystems/CI runners. This only widens the allowance for slow
    // environments — it does not mask genuine hangs (timeouts inside
    // gitworthy's own git/http/tar code paths remain far smaller than this).
    testTimeout: 40_000,
    hookTimeout: 40_000,
    // Capping concurrent test-file worker processes avoids exhausting OS
    // process/handle limits when many files each spawn real `git` subprocesses
    // in parallel (observed as intermittent "spawn UNKNOWN" fork failures and
    // hook timeouts on constrained cloud runners).
    maxWorkers: 1
  }
});
