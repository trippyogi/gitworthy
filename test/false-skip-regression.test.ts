import { beforeEach, describe, expect, it, vi } from 'vitest';
import { branch_scan } from '../src/core/branch-scan.js';
import { dupe_cluster } from '../src/core/dupe-cluster.js';

const mocks = vi.hoisted(() => ({
  heads: vi.fn(),
  githubJson: vi.fn()
}));

vi.mock('../src/lib/git.js', () => ({
  lsRemoteHeads: mocks.heads,
  shallowClone: vi.fn(async () => ({ dir: process.cwd(), cleanup: async () => undefined }))
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: mocks.githubJson,
  fetchRaw: vi.fn(async () => null)
}));

function issue(number: number, title: string, state = 'open', body = '') {
  return {
    number,
    title,
    body,
    state,
    labels: [],
    comments: 0,
    html_url: `https://github.com/o/r/issues/${number}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: state === 'closed' ? '2026-01-02T00:00:00Z' : null
  };
}

describe('false SKIP regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.heads.mockResolvedValue([]);
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path.includes('/commits/')) return { commit: { author: { date: new Date().toISOString() }, message: 'recent work' }, html_url: 'https://github.com/o/r/commit/abc' };
      if (path.includes('/search/issues')) return { items: [] };
      if (path.includes('/issues?')) return [];
      return issue(1, 'target issue');
    });
  });

  it('does not emit in_flight from only broad single-token branch matches', async () => {
    mocks.heads.mockResolvedValue([
      { name: 'add-domain-allowlist', sha: 'abc' },
      { name: 'agent-maintenance', sha: 'def' }
    ]);

    const result = await branch_scan({ repo: 'o/r', keywords: ['iframe', 'domain', 'agent'], force_refresh: true });

    expect(result.signals).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.verdict_summary).toBe('no matching remote branches found.');
  });

  it('still emits in_flight for a specific single-token branch match', async () => {
    mocks.heads.mockResolvedValue([{ name: 'recover-sleep-interrupted-turns', sha: 'abc' }]);

    const result = await branch_scan({ repo: 'o/r', keywords: ['sleep'], force_refresh: true });

    expect(result.signals).toEqual(['in_flight']);
    expect(result.evidence[0]).toMatchObject({ branch: 'recover-sleep-interrupted-turns' });
  });

  it('does not emit duplicate for a weakly related closed issue', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path.includes('/search/issues')) return { items: [issue(1391, 'Improve notification settings', 'closed', 'agent domain workspace configuration iframe issue')] };
      if (path.includes('/issues?')) return [];
      if (path.includes('/issues/1659')) return issue(1659, 'Iframe sandbox fails to load app preview', 'open', 'agent domain workspace configuration iframe issue');
      return issue(1659, 'Iframe sandbox fails to load app preview', 'open');
    });

    const result = await dupe_cluster({ repo: 'o/r', issue_number: 1659 });

    expect(result.signals).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.verdict_summary).toBe('no lexical duplicate candidates found.');
  });

  it('keeps duplicate for a closed issue with a strong title match', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path.includes('/search/issues')) return { items: [issue(1391, 'Iframe sandbox fails to load app preview', 'closed', 'same problem')] };
      if (path.includes('/issues?')) return [];
      if (path.includes('/issues/1659')) return issue(1659, 'Iframe sandbox fails to load app preview', 'open', 'same problem');
      return issue(1659, 'Iframe sandbox fails to load app preview', 'open');
    });

    const result = await dupe_cluster({ repo: 'o/r', issue_number: 1659 });

    expect(result.signals).toEqual(['duplicate']);
    expect(result.evidence[0]).toMatchObject({ number: 1391, closed: true });
  });
});
