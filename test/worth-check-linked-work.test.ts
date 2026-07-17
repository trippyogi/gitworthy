import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const envelope = (input: { verdict_summary: string; evidence: Array<Record<string, unknown>>; signals?: string[]; checked: string[]; not_checked: string[] }) => ({ ...input, signals: input.signals ?? [], cached: false, fetched_at: '2026-01-01T00:00:00.000Z' });
  return {
    branchScan: vi.fn(async () => envelope({ verdict_summary: 'no matching remote branches found.', evidence: [], checked: ['mock branch scan'], not_checked: ['fork branches are invisible to this remote branch scan.'] })),
    issueVsMain: vi.fn(async () => envelope({ verdict_summary: 'no evidence on main.', evidence: [{ issue: 1, title: 'Add feature', state: 'open', labels: [], comments: 0, url: 'https://github.com/o/r/issues/1' }], checked: ['mock issue check'], not_checked: ["directory or string existence does not prove the issue's intent is satisfied; read both before making any public claim."] })),
    dupeCluster: vi.fn(async () => envelope({ verdict_summary: 'no lexical duplicate candidates found.', evidence: [], checked: ['mock dupes'], not_checked: ['lexical similarity only; semantic duplicates with different vocabulary will be missed.'] })),
    contribPolicy: vi.fn(async () => envelope({ verdict_summary: 'no contribution policy signals found.', evidence: [], checked: ['mock policy'], not_checked: ['policy extraction is keyword and heading based; ambiguous sections are reported rather than inferred.'] })),
    linkedWork: vi.fn(async () => envelope({ verdict_summary: 'no linked pull requests or current assignees found.', evidence: [], checked: ['mock linked'], not_checked: ['PR linkage depends on GitHub cross-reference events or explicit issue-number mentions; a PR that never mentions the issue number remains invisible.'] }))
  };
});

vi.mock('../src/core/branch-scan.js', () => ({ branch_scan: mocks.branchScan }));
vi.mock('../src/core/issue-vs-main.js', () => ({ issue_vs_main: mocks.issueVsMain }));
vi.mock('../src/core/dupe-cluster.js', () => ({ dupe_cluster: mocks.dupeCluster }));
vi.mock('../src/core/contrib-policy.js', () => ({ contrib_policy: mocks.contribPolicy }));
vi.mock('../src/core/linked-work.js', () => ({ linked_work: mocks.linkedWork }));

const { worth_check } = await import('../src/core/worth-check.js');

describe('worth_check linked work rubric', () => {
  it('skips when an open linked PR exists', async () => {
    mocks.linkedWork.mockResolvedValueOnce({ verdict_summary: 'found 1 linked pull request and 0 assignees.', evidence: [{ kind: 'linked_pr', number: 4499, state: 'open', draft: false, merged: false, date: '2026-07-08T16:54:42Z', author: 'tarunag10', url: 'https://github.com/modelcontextprotocol/servers/pull/4499' }], signals: ['linked_pr_open'], checked: ['mock linked'], not_checked: ['PR linkage depends on GitHub cross-reference events or explicit issue-number mentions; a PR that never mentions the issue number remains invisible.'], cached: false, fetched_at: '2026-01-01T00:00:00.000Z' });
    const result = await worth_check({ repo: 'o/r', issue_number: 1 });
    expect(result.verdict).toBe('SKIP');
    expect(result.reasons).toContain('open linked PR found: #4499 https://github.com/modelcontextprotocol/servers/pull/4499');
  });

  it('caps ACT to VERIFY when the issue is assigned', async () => {
    mocks.linkedWork.mockResolvedValueOnce({ verdict_summary: 'found 0 linked pull requests and 1 assignee.', evidence: [{ kind: 'assignment', assignee: 'cconstable', assigned_at: '2026-07-06T13:50:11Z', assigned_by: 'yuandrew' }], signals: ['assigned'], checked: ['mock linked'], not_checked: ['PR linkage depends on GitHub cross-reference events or explicit issue-number mentions; a PR that never mentions the issue number remains invisible.'], cached: false, fetched_at: '2026-01-01T00:00:00.000Z' });
    const result = await worth_check({ repo: 'o/r', issue_number: 1 });
    expect(result.verdict).toBe('VERIFY');
    expect(result.reasons).toContain('issue is assigned: cconstable at 2026-07-06T13:50:11Z');
  });

  it('caps ACT to VERIFY when a closed unmerged linked PR exists', async () => {
    mocks.linkedWork.mockResolvedValueOnce({ verdict_summary: 'found 1 linked pull request and 0 assignees.', evidence: [{ kind: 'linked_pr', number: 528, state: 'closed', draft: false, merged: false, date: '2026-07-08T16:54:42Z', author: 'someone', url: 'https://github.com/o/r/pull/528' }], signals: ['linked_pr_closed'], checked: ['mock linked'], not_checked: ['PR linkage depends on GitHub cross-reference events or explicit issue-number mentions; a PR that never mentions the issue number remains invisible.'], cached: false, fetched_at: '2026-01-01T00:00:00.000Z' });
    const result = await worth_check({ repo: 'o/r', issue_number: 1 });
    expect(result.verdict).toBe('VERIFY');
    expect(result.reasons).toContain('closed unmerged linked PR found: #528 https://github.com/o/r/pull/528');
  });
});
