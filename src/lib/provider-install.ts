/** Install provider replay sessions onto production provider entry points (GW-022). */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderFixturePackSchema, type ProviderFixturePack } from '../contracts/provider-fixtures.js';
import { clearGithubCachesForTests, configureGithubHttpForTests } from './github.js';
import { configureGitEvalHooks, resetGitCachesForTests } from './git.js';
import { createGitReplaySession, type GitReplaySession } from './git-replay.js';
import { createHttpReplaySession, type HttpReplaySession } from './provider-replay.js';
import { configureNpmHttpForTests } from './registry.js';

export type ReplayInstall = {
  pack: ProviderFixturePack;
  http: HttpReplaySession;
  git: GitReplaySession;
  assertExhausted: () => void;
  uninstall: () => Promise<void>;
};

export async function loadProviderFixturePack(filePath: string): Promise<ProviderFixturePack> {
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  return ProviderFixturePackSchema.parse(raw);
}

/**
 * Wire fixture replay into GitHub/npm HTTP clients and git remote hooks.
 * Callers must set a dummy GITHUB_TOKEN when exercising githubJson.
 */
export async function installProviderReplay(packInput: ProviderFixturePack | string): Promise<ReplayInstall> {
  const pack = typeof packInput === 'string' ? await loadProviderFixturePack(packInput) : ProviderFixturePackSchema.parse(packInput);
  const http = createHttpReplaySession(pack);
  const git = createGitReplaySession(pack);

  clearGithubCachesForTests();
  await resetGitCachesForTests();
  configureGithubHttpForTests({ transport: http.transport, maxRetries: 0 });
  configureNpmHttpForTests({ transport: http.transport, maxRetries: 0 });
  configureGitEvalHooks(git.hooks);

  return {
    pack,
    http,
    git,
    assertExhausted: () => {
      http.assertExhausted();
      git.assertExhausted();
    },
    uninstall: async () => {
      configureGithubHttpForTests(null);
      configureNpmHttpForTests(null);
      configureGitEvalHooks(null);
      clearGithubCachesForTests();
      await git.cleanup();
      await resetGitCachesForTests();
    }
  };
}

/** Isolated cache directory helpers for deterministic frozen runs. */
export async function withIsolatedCacheDirs<T>(fn: (dirs: { cacheDir: string }) => Promise<T>): Promise<T> {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-eval-cache-'));
  const previousCache = process.env.GITWORTHY_CACHE_DIR;
  const previousGithubCache = process.env.GITWORTHY_GITHUB_CACHE_MS;
  process.env.GITWORTHY_CACHE_DIR = cacheDir;
  process.env.GITWORTHY_GITHUB_CACHE_MS = '0';
  try {
    return await fn({ cacheDir });
  } finally {
    if (previousCache === undefined) delete process.env.GITWORTHY_CACHE_DIR;
    else process.env.GITWORTHY_CACHE_DIR = previousCache;
    if (previousGithubCache === undefined) delete process.env.GITWORTHY_GITHUB_CACHE_MS;
    else process.env.GITWORTHY_GITHUB_CACHE_MS = previousGithubCache;
    await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
