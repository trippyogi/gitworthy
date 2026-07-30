import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const defaultGithubJson = async (requestPath: string) => {
    if (requestPath === '/rate_limit') return { resources: { core: { limit: 5000, remaining: 4999, reset: 1234567890 } } };
    if (requestPath === '/user') return { login: 'octocat' };
    if (requestPath.includes('/timeline')) return [
      { event: 'cross-referenced', created_at: '2026-07-09T00:00:00Z' },
      { event: 'assigned', created_at: '2026-07-08T00:00:00Z' }
    ];
    throw new Error(`unexpected path ${requestPath}`);
  };
  return {
    defaultGithubJson,
    githubJson: vi.fn(defaultGithubJson),
    githubToken: vi.fn(() => 'test-token'),
    cacheRoot: vi.fn(() => '')
  };
});

vi.mock('../src/lib/github.js', () => ({
  githubJson: mocks.githubJson,
  githubToken: mocks.githubToken
}));

vi.mock('../src/lib/cache.js', () => ({
  cacheRoot: mocks.cacheRoot
}));

vi.mock('../src/lib/registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/registry.js')>('../src/lib/registry.js');
  return {
    ...actual,
    npmMetadata: vi.fn(async () => ({
      name: 'gitworthy',
      'dist-tags': { latest: '0.3.6' },
      versions: {},
      time: {}
    }))
  };
});

const { doctor } = await import('../src/core/doctor.js');
const { npmMetadata } = await import('../src/lib/registry.js');

let cacheDir: string;

describe('doctor', () => {
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-doctor-cache-'));
    mocks.githubJson.mockImplementation(mocks.defaultGithubJson);
    mocks.githubToken.mockReturnValue('test-token');
    mocks.cacheRoot.mockReturnValue(cacheDir);
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('reports ready when token, auth, rate limit, cache, and timeline all check out', async () => {
    const result = await doctor();
    expect(result.verdict_summary).toContain('ready');
    expect(result.signals).toEqual([]);
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'auth', token_present: true }));
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'auth', ok: true, login: 'octocat' }));
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'rate_limit', remaining: 4999, limit: 5000 }));
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'cache', writable: true }));
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'version', local: expect.any(String), npm_latest: '0.3.6' }));
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'timeline_probe', event_types: ['assigned', 'cross-referenced'] }));
    expect(result.checked.length).toBeGreaterThan(0);
    expect(result.not_checked.length).toBeGreaterThan(0);
  });

  it('reports token missing without throwing and skips network checks', async () => {
    mocks.githubToken.mockReturnValue(undefined);
    const result = await doctor();
    expect(result.verdict_summary).toContain('missing');
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'auth', token_present: false }));
    expect(result.evidence.some((item) => item.kind === 'rate_limit')).toBe(false);
    expect(result.evidence.some((item) => item.kind === 'timeline_probe')).toBe(false);
    expect(result.not_checked.join(' ')).toContain('no GITHUB_TOKEN or GH_TOKEN is present');
    expect(mocks.githubJson).not.toHaveBeenCalled();
  });

  it('reports auth failure and skips the timeline probe', async () => {
    mocks.githubJson.mockImplementation(async (requestPath: string) => {
      if (requestPath === '/rate_limit') return { resources: { core: { limit: 5000, remaining: 4999, reset: 1234567890 } } };
      if (requestPath === '/user') throw new Error('Bad credentials');
      throw new Error(`unexpected path ${requestPath}`);
    });
    const result = await doctor();
    expect(result.verdict_summary).toContain('authentication failed');
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'auth', ok: false, error: 'Bad credentials' }));
    expect(result.evidence.some((item) => item.kind === 'timeline_probe')).toBe(false);
    expect(result.not_checked.join(' ')).toContain('timeline capability was not checked because GitHub authentication failed');
  });

  it('flags a low rate limit as ready with caution', async () => {
    mocks.githubJson.mockImplementation(async (requestPath: string) => {
      if (requestPath === '/rate_limit') return { resources: { core: { limit: 5000, remaining: 5, reset: 1234567890 } } };
      if (requestPath === '/user') return { login: 'octocat' };
      if (requestPath.includes('/timeline')) return [{ event: 'cross-referenced', created_at: '2026-07-09T00:00:00Z' }];
      throw new Error(`unexpected path ${requestPath}`);
    });
    const result = await doctor();
    expect(result.verdict_summary).toContain('rate limit is low');
  });

  it('notes when the timeline probe never observes cross-referenced events', async () => {
    mocks.githubJson.mockImplementation(async (requestPath: string) => {
      if (requestPath === '/rate_limit') return { resources: { core: { limit: 5000, remaining: 4999, reset: 1234567890 } } };
      if (requestPath === '/user') return { login: 'octocat' };
      if (requestPath.includes('/timeline')) return [{ event: 'assigned', created_at: '2026-07-08T00:00:00Z' }];
      throw new Error(`unexpected path ${requestPath}`);
    });
    const result = await doctor();
    expect(result.not_checked.join(' ')).toContain('weak tokens');
    expect(result.not_checked.join(' ')).toContain('under-count linked PRs');
  });

  it('degrades gracefully when the npm registry lookup fails, without failing the whole check', async () => {
    vi.mocked(npmMetadata).mockRejectedValueOnce(new Error('registry unavailable'));
    const result = await doctor();
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'version', npm_latest: null }));
    expect(result.not_checked.join(' ')).toContain('npm registry latest version for gitworthy was not checked');
    expect(result.verdict_summary).toContain('ready');
  });

  it('reports an unwritable cache directory as not ready', async () => {
    await writeFile(path.join(cacheDir, 'blocker'), 'not a directory');
    mocks.cacheRoot.mockReturnValue(path.join(cacheDir, 'blocker', 'subdir'));
    const result = await doctor();
    expect(result.verdict_summary).toContain('cache directory');
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'cache', writable: false }));
  });

  it('accepts a custom probe repo and issue number', async () => {
    mocks.githubJson.mockImplementation(async (requestPath: string) => {
      if (requestPath === '/rate_limit') return { resources: { core: { limit: 5000, remaining: 4999, reset: 1234567890 } } };
      if (requestPath === '/user') return { login: 'octocat' };
      if (requestPath === '/repos/octocat/Hello-World/issues/1/timeline?per_page=5') return [{ event: 'cross-referenced' }];
      throw new Error(`unexpected path ${requestPath}`);
    });
    const result = await doctor({ probe_repo: 'octocat/Hello-World', probe_issue_number: 1 });
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'timeline_probe', repo: 'octocat/Hello-World', issue_number: 1 }));
  });
});
