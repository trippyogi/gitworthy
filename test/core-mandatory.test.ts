import { describe, expect, it, vi } from 'vitest';
import { branch_scan } from '../src/core/branch-scan.js';
import { dupe_cluster } from '../src/core/dupe-cluster.js';
import { issue_vs_main } from '../src/core/issue-vs-main.js';
import { worth_check } from '../src/core/worth-check.js';

vi.mock('../src/lib/git.js', () => ({
  lsRemoteHeads: vi.fn(async () => []),
  shallowClone: vi.fn(async () => ({ dir: process.cwd(), cleanup: async () => undefined }))
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: vi.fn(async (path: string) => {
    if (path.includes('missing')) throw new Error('missing repo');
    if (path.includes('/search/issues')) return { items: [] };
    if (path.includes('/issues?')) return [];
    return { number: 1, title: 'Add fastapi example', body: 'example-apps/fastapi', state: 'open', labels: [], comments: 0, html_url: 'https://github.com/o/r/issues/1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null };
  }),
  fetchRaw: vi.fn(async () => null)
}));

describe('mandatory calibration fields', () => {
  it('branch_scan includes mandatory limitations', async () => {
    const result = await branch_scan({ repo: 'o/r', keywords: ['x'], force_refresh: true });
    expect(result.not_checked.join(' ')).toContain('fork branches');
    expect(result.not_checked.join(' ')).toContain('lexical');
  });

  it('issue_vs_main includes the intent limitation', async () => {
    const result = await issue_vs_main({ repo: 'o/r', issue_number: 1 });
    expect(result.not_checked.join(' ')).toContain("does not prove the issue's intent is satisfied");
  });

  it('dupe_cluster includes the lexical duplicate limitation', async () => {
    const result = await dupe_cluster({ repo: 'o/r', issue_number: 1 });
    expect(result.not_checked.join(' ')).toContain('semantic duplicates with different vocabulary will be missed');
  });

  it('worth_check degrades to VERIFY on sub-check errors', async () => {
    const result = await worth_check({ repo: 'missing/repo', issue_number: 1 });
    expect(result.verdict).toBe('VERIFY');
    expect(result.reasons.some((reason) => reason.includes('errored'))).toBe(true);
  });
});
