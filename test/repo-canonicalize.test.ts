import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitworthyError } from '../src/core/envelope.js';
import { writeCache } from '../src/lib/cache.js';

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn()
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: mocks.githubJson,
  fetchRaw: vi.fn(async () => null)
}));

describe('repository canonicalization', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-repo-'));
    process.env.GITWORTHY_CACHE_DIR = dir;
    process.env.GITWORTHY_CACHE_VERSION = '0.3.3-test';
    vi.clearAllMocks();
  });

  afterEach(async () => {
    delete process.env.GITWORTHY_CACHE_DIR;
    delete process.env.GITWORTHY_CACHE_VERSION;
    await rm(dir, { recursive: true, force: true });
  });

  it('uses the canonical full_name in Search queries after a rename', async () => {
    mocks.githubJson.mockImplementation(async (requestPath: string) => {
      if (requestPath === '/repos/mendableai/firecrawl') {
        return { full_name: 'firecrawl/firecrawl', default_branch: 'main', html_url: 'https://github.com/firecrawl/firecrawl' };
      }
      if (requestPath.includes('/issues/1') && !requestPath.includes('search') && !requestPath.includes('?')) {
        return {
          number: 1,
          title: 'Crawl timeout on large sites',
          body: 'timeout crawl large sites',
          state: 'open',
          labels: [],
          comments: 0,
          html_url: 'https://github.com/mendableai/firecrawl/issues/1',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          closed_at: null
        };
      }
      if (requestPath.includes('/search/issues')) return { items: [] };
      if (requestPath.includes('/issues?')) return [];
      throw new Error(`unexpected path ${requestPath}`);
    });

    const { dupe_cluster } = await import('../src/core/dupe-cluster.js');
    await dupe_cluster({ repo: 'mendableai/firecrawl', issue_number: 1, max_candidates: 10 });

    const searchCall = mocks.githubJson.mock.calls.find(([requestPath]) => String(requestPath).includes('/search/issues'));
    expect(searchCall?.[0]).toContain(encodeURIComponent('repo:firecrawl/firecrawl'));
    expect(searchCall?.[0]).not.toContain(encodeURIComponent('repo:mendableai/firecrawl'));
  });

  it('busts the repo cache and re-resolves after a Search API 422 on a cached canonical name', async () => {
    await writeCache('resolve_repo', { repo: 'mendableai/firecrawl' }, {
      full_name: 'stale/firecrawl',
      default_branch: 'main',
      html_url: 'https://github.com/stale/firecrawl'
    });

    let searchAttempts = 0;
    mocks.githubJson.mockImplementation(async (requestPath: string) => {
      if (requestPath === '/repos/mendableai/firecrawl') {
        return { full_name: 'firecrawl/firecrawl', default_branch: 'main', html_url: 'https://github.com/firecrawl/firecrawl' };
      }
      if (requestPath.includes('/issues/1') && !requestPath.includes('search') && !requestPath.includes('?')) {
        return {
          number: 1,
          title: 'Crawl timeout on large sites',
          body: 'timeout crawl large sites',
          state: 'open',
          labels: [],
          comments: 0,
          html_url: 'https://github.com/mendableai/firecrawl/issues/1',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          closed_at: null
        };
      }
      if (requestPath.includes('/search/issues')) {
        searchAttempts += 1;
        if (searchAttempts === 1) {
          throw new GitworthyError({
            code: 'github_api_error',
            message: 'GitHub API request failed for https://api.github.com/search/issues with status 422: Validation Failed.',
            status: 422
          });
        }
        return { items: [] };
      }
      if (requestPath.includes('/issues?')) return [];
      throw new Error(`unexpected path ${requestPath}`);
    });

    const { dupe_cluster } = await import('../src/core/dupe-cluster.js');
    const result = await dupe_cluster({ repo: 'mendableai/firecrawl', issue_number: 1, max_candidates: 10 });

    expect(searchAttempts).toBe(2);
    expect(result.checked.join(' ')).toContain('re-resolved repository after a Search API 422 on a cached canonical name');
    const searchCalls = mocks.githubJson.mock.calls.filter(([requestPath]) => String(requestPath).includes('/search/issues'));
    expect(searchCalls[0]?.[0]).toContain(encodeURIComponent('repo:stale/firecrawl'));
    expect(searchCalls[1]?.[0]).toContain(encodeURIComponent('repo:firecrawl/firecrawl'));
  });
});
