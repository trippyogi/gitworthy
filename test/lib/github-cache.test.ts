import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearGithubCachesForTests, githubJson } from '../../src/lib/github.js';

let originalGithubToken: string | undefined;
let originalCacheMs: string | undefined;

describe('github client caching', () => {
  beforeEach(() => {
    originalGithubToken = process.env.GITHUB_TOKEN;
    originalCacheMs = process.env.GITWORTHY_GITHUB_CACHE_MS;
    process.env.GITHUB_TOKEN = 'token';
    delete process.env.GITWORTHY_GITHUB_CACHE_MS;
    clearGithubCachesForTests();
  });

  afterEach(() => {
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGithubToken;
    if (originalCacheMs === undefined) delete process.env.GITWORTHY_GITHUB_CACHE_MS;
    else process.env.GITWORTHY_GITHUB_CACHE_MS = originalCacheMs;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearGithubCachesForTests();
  });

  it('coalesces two parallel identical GET calls into a single fetch (singleflight)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const [first, second] = await Promise.all([
      githubJson('/repos/a/b'),
      githubJson('/repos/a/b')
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
  });

  it('serves a second sequential call within the TTL from cache without refetching', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await githubJson('/repos/a/b');
    const second = await githubJson('/repos/a/b');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
  });

  it('does not cache or coalesce non-GET requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await githubJson('/repos/a/b', { method: 'POST' });
    await githubJson('/repos/a/b', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not permanently cache a failed request; a later call refetches', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(githubJson('/repos/a/b')).rejects.toMatchObject({ code: 'github_api_error' });
    const result = await githubJson('/repos/a/b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true });
  });

  it('treats different query strings as different cache keys', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await githubJson('/repos/a/b?page=1');
    await githubJson('/repos/a/b?page=2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bypasses the TTL cache (but still coalesces) when GITWORTHY_GITHUB_CACHE_MS=0', async () => {
    process.env.GITWORTHY_GITHUB_CACHE_MS = '0';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await githubJson('/repos/a/b');
    await githubJson('/repos/a/b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clearGithubCachesForTests clears both the TTL cache and in-flight map', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await githubJson('/repos/a/b');
    clearGithubCachesForTests();
    await githubJson('/repos/a/b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
