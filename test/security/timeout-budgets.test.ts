import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GitworthyError } from '../../src/core/envelope.js';
import { createHttpClient, HttpClientError } from '../../src/lib/http-client.js';
import * as git from '../../src/lib/git.js';
import { inspectTarball } from '../../src/lib/registry.js';
import { buildTar, hangingHttpClient, tarballHttpClient, tarEntry } from '../helpers/tar-fixture.js';

// Mocked once for the whole file (vitest hoists vi.mock above these imports):
// every `git` subprocess call behaves as if it hit the wall-clock timeout, so
// the git.ts call sites below are exercised against a deterministic, offline,
// always-reproducible timeout instead of racing a real slow process. Nothing
// else in this file (http-client.ts, registry.ts) imports `execa`, so they are
// unaffected by this mock.
vi.mock('execa', () => ({
  execa: vi.fn(async () => {
    const error = new Error('Command timed out after 15000 milliseconds: git ...');
    Object.assign(error, { timedOut: true, signal: 'SIGTERM' });
    throw error;
  })
}));

/**
 * GW-014: wall-clock timeout enforcement across every network/subprocess path
 * gitworthy reads hostile input from — `git` subprocesses, raw HTTP requests,
 * and npm tarball streaming. Git and HTTP timeout mapping is exercised here
 * with mocks (no real slow process/server needed for a deterministic,
 * offline-safe test); the fuller HTTP retry/backoff matrix lives in
 * test/lib/http-client.test.ts and the fuller tarball budget matrix lives in
 * test/lib/registry-tarball.test.ts — this file only re-asserts their typed
 * timeout outcomes as part of the release-facing security gate.
 */

describe('GIT_SUBPROCESS_TIMEOUT_MS coverage guard', () => {
  it('every `execa(\'git\', ...)` call site in src/lib/git.ts passes an explicit timeout option', () => {
    const gitTsPath = fileURLToPath(new URL('../../src/lib/git.ts', import.meta.url));
    const source = readFileSync(gitTsPath, 'utf8');
    const callSitePattern = /execa\(\s*(['"])git\1/g;
    const indices = [...source.matchAll(callSitePattern)].map((match) => match.index);

    // If this count changes, a new git subprocess call site was added (or
    // removed) — update the count once you have confirmed the new call site
    // also passes an explicit `timeout`/`timeoutMs` option below.
    expect(indices).toHaveLength(8);

    for (let i = 0; i < indices.length; i += 1) {
      const start = indices[i]!;
      const end = i + 1 < indices.length ? indices[i + 1]! : source.length;
      const callSite = source.slice(start, Math.min(end, start + 500));
      expect(callSite).toMatch(/timeout/);
    }
  });
});

describe('git subprocess timeouts fail safe / typed (mocked execa)', () => {
  it('listTreeFiles surfaces a typed GitworthyError instead of an unhandled subprocess timeout', async () => {
    const promise = git.listTreeFiles('/nonexistent/does-not-matter');
    await expect(promise).rejects.toBeInstanceOf(GitworthyError);
    await expect(promise).rejects.toMatchObject({ code: 'git_ls_tree_failed' });
  });

  it('readTreeFile degrades to null (fail-safe) rather than throwing on a subprocess timeout', async () => {
    const content = await git.readTreeFile('/nonexistent/does-not-matter', {
      path: 'whatever.txt',
      sha: '0'.repeat(40),
      symlink: false
    });
    expect(content).toBeNull();
  });

  it('lsRemoteHeads surfaces a typed GitworthyError on a subprocess timeout', async () => {
    const promise = git.lsRemoteHeads('octocat/hello-world');
    await expect(promise).rejects.toBeInstanceOf(GitworthyError);
    await expect(promise).rejects.toMatchObject({ code: 'git_ls_remote_failed' });
  });

  it('shallowClone surfaces a typed GitworthyError on a subprocess timeout', async () => {
    const promise = git.shallowClone('octocat/hello-world');
    await expect(promise).rejects.toBeInstanceOf(GitworthyError);
    await expect(promise).rejects.toMatchObject({ code: 'git_clone_failed' });
  });

  it('gitOutput surfaces a typed GitworthyError on a subprocess timeout', async () => {
    const promise = git.gitOutput('/nonexistent/does-not-matter', ['status']);
    await expect(promise).rejects.toBeInstanceOf(GitworthyError);
    await expect(promise).rejects.toMatchObject({ code: 'git_command_failed' });
  });
});

describe('http-client timeout (see test/lib/http-client.test.ts for the full matrix)', () => {
  it('maps a non-resolving transport to a typed http_timeout error', async () => {
    const transport = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    const client = createHttpClient({ transport, timeoutMs: 20, maxRetries: 0 });

    await expect(client.request('https://registry.npmjs.org/hostile-package')).rejects.toBeInstanceOf(HttpClientError);
    await expect(client.request('https://registry.npmjs.org/hostile-package')).rejects.toMatchObject({ code: 'http_timeout' });
  });
});

describe('npm tarball timeout (see test/lib/registry-tarball.test.ts for the full matrix)', () => {
  it('maps a non-resolving tarball transport to a typed npm_tarball_timeout error', async () => {
    const promise = inspectTarball('https://example.com/hostile-1.0.0.tgz', {
      matches: () => true,
      readContent: false,
      caps: { timeoutMs: 20 },
      httpClient: hangingHttpClient()
    });
    await expect(promise).rejects.toBeInstanceOf(GitworthyError);
    await expect(promise).rejects.toMatchObject({ code: 'npm_tarball_timeout' });
  });

  it('a well-behaved (non-hanging) tarball request within the timeout still succeeds', async () => {
    // Sanity check for the timeout test above: guards against an inverted
    // condition that would make every request look "timed out".
    const tar = buildTar([tarEntry({ path: 'package/ok.txt', content: 'fine\n' })]);
    const result = await inspectTarball('https://example.com/fine-1.0.0.tgz', {
      matches: () => true,
      readContent: true,
      caps: { timeoutMs: 5000 },
      httpClient: tarballHttpClient(tar)
    });
    expect(result.matches.map((m) => m.path)).toEqual(['ok.txt']);
  });
});
