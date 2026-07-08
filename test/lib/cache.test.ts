import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCache, writeCache } from '../../src/lib/cache.js';

let dir: string;

describe('cache', () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-cache-test-'));
    process.env.GITWORTHY_CACHE_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.GITWORTHY_CACHE_DIR;
    delete process.env.GITWORTHY_CACHE_VERSION;
    await rm(dir, { recursive: true, force: true });
  });

  it('honors ttl and force_refresh', async () => {
    await writeCache('scope', { a: 1 }, { ok: true }, '2026-01-01T00:00:00.000Z');
    await expect(readCache('scope', { a: 1 }, 60_000)).resolves.toMatchObject({ hit: true, value: { ok: true } });
    await expect(readCache('scope', { a: 1 }, 60_000, true)).resolves.toEqual({ hit: false });
    await expect(readCache('scope', { a: 1 }, -1)).resolves.toEqual({ hit: false });
  });

  it('misses envelopes cached under a different package version', async () => {
    process.env.GITWORTHY_CACHE_VERSION = '1.0.0';
    await writeCache('scope', { a: 1 }, { ok: true }, '2026-01-01T00:00:00.000Z');
    await expect(readCache('scope', { a: 1 }, 60_000)).resolves.toMatchObject({ hit: true, value: { ok: true } });
    process.env.GITWORTHY_CACHE_VERSION = '1.0.1';
    await expect(readCache('scope', { a: 1 }, 60_000)).resolves.toEqual({ hit: false });
  });
});
