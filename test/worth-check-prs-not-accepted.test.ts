import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const envelope = (input: { verdict_summary: string; evidence: Array<Record<string, unknown>>; signals?: string[]; checked: string[]; not_checked: string[] }) => ({ ...input, signals: input.signals ?? [], cached: false, fetched_at: '2026-01-01T00:00:00.000Z' });
  return {
    branchScan: vi.fn(async () => envelope({ verdict_summary: 'no matching remote branches found.', evidence: [], checked: ['mock branch scan'], not_checked: ['fork branches are invisible to this remote branch scan.'] })),
    issueVsMain: vi.fn(async () => envelope({ verdict_summary: 'no evidence on main.', evidence: [{ issue: 1, title: 'Add feature', state: 'open', labels: [], comments: 0, url: 'https://github.com/mirror/repo/issues/1' }], checked: ['mock issue check'], not_checked: ["directory or string existence does not prove the issue's intent is satisfied; read both before making any public claim."] })),
    dupeCluster: vi.fn(async () => envelope({ verdict_summary: 'no lexical duplicate candidates found.', evidence: [], checked: ['mock dupes'], not_checked: ['lexical similarity only; semantic duplicates with different vocabulary will be missed.'] })),
    contribPolicy: vi.fn(async () => envelope({ verdict_summary: 'found 1 contribution policy signal.', evidence: [{ category: 'prs_not_accepted', excerpt: 'Pull requests are not accepted here.' }], signals: ['prs_not_accepted'], checked: ['mock policy'], not_checked: ['policy extraction is keyword and heading based; ambiguous sections are reported rather than inferred.'] }))
  };
});

vi.mock('../src/core/branch-scan.js', () => ({ branch_scan: mocks.branchScan }));
vi.mock('../src/core/issue-vs-main.js', () => ({ issue_vs_main: mocks.issueVsMain }));
vi.mock('../src/core/dupe-cluster.js', () => ({ dupe_cluster: mocks.dupeCluster }));
vi.mock('../src/core/contrib-policy.js', () => ({ contrib_policy: mocks.contribPolicy }));

const { worth_check } = await import('../src/core/worth-check.js');

describe('worth_check PR rejection cap', () => {
  it('caps ACT to VERIFY when the repository does not accept PRs', async () => {
    const result = await worth_check({ repo: 'mirror/repo', issue_number: 1 });
    expect(result.signals).toContain('prs_not_accepted');
    expect(result.verdict).toBe('VERIFY');
    expect(result.verdict_summary).toContain('mixed signals');
  });
});
