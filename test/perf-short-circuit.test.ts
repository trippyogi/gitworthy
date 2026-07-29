import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../src/core/envelope.js';

const mocks = vi.hoisted(() => ({
  issueVsMain: vi.fn(async () => createEnvelope({
    verdict_summary: 'no evidence on main.',
    evidence: [{ title: 'Something distinctive here' }],
    checked: ['mock issue'],
    not_checked: ['mock']
  })),
  branchScan: vi.fn(async () => createEnvelope({
    verdict_summary: 'no matching remote branches found.',
    evidence: [],
    checked: ['mock branch'],
    not_checked: ['mock']
  })),
  linkedWork: vi.fn(async () => createEnvelope({
    verdict_summary: 'found 1 linked pull request and 0 assignees.',
    evidence: [{ kind: 'linked_pr', number: 99, state: 'open', closes_issue: true, url: 'https://github.com/o/r/pull/99' }],
    signals: ['linked_pr_open'],
    checked: ['mock linked'],
    not_checked: ['mock']
  })),
  dupeCluster: vi.fn(async () => createEnvelope({
    verdict_summary: 'no lexical duplicate candidates found.',
    evidence: [],
    checked: ['mock dupe'],
    not_checked: ['mock']
  })),
  contribPolicy: vi.fn(async () => createEnvelope({
    verdict_summary: 'no contribution policy signals found.',
    evidence: [],
    checked: ['mock policy'],
    not_checked: ['mock']
  })),
  releaseGap: vi.fn(async () => createEnvelope({
    verdict_summary: 'main and npm are equal.',
    evidence: [],
    checked: ['mock release'],
    not_checked: ['mock']
  })),
  githubJson: vi.fn(async () => ({
    number: 1,
    title: 'Something distinctive here',
    body: null,
    state: 'open',
    labels: [],
    assignees: [],
    comments: 0,
    html_url: 'https://github.com/o/r/issues/1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null
  }))
}));

vi.mock('../src/core/issue-vs-main.js', () => ({ issue_vs_main: mocks.issueVsMain }));
vi.mock('../src/core/branch-scan.js', () => ({ branch_scan: mocks.branchScan }));
vi.mock('../src/core/linked-work.js', () => ({ linked_work: mocks.linkedWork }));
vi.mock('../src/core/dupe-cluster.js', () => ({ dupe_cluster: mocks.dupeCluster }));
vi.mock('../src/core/contrib-policy.js', () => ({ contrib_policy: mocks.contribPolicy }));
vi.mock('../src/core/release-gap.js', () => ({ release_gap: mocks.releaseGap }));
vi.mock('../src/lib/github.js', () => ({ githubJson: mocks.githubJson }));

const { worth_check } = await import('../src/core/worth-check.js');

describe('worth_check perf short-circuit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.linkedWork.mockResolvedValue(createEnvelope({
      verdict_summary: 'found 1 linked pull request and 0 assignees.',
      evidence: [{ kind: 'linked_pr', number: 99, state: 'open', closes_issue: true, url: 'https://github.com/o/r/pull/99' }],
      signals: ['linked_pr_open'],
      checked: ['mock linked'],
      not_checked: ['mock']
    }));
  });

  it('skips clone/branch/dupe after an open linked PR', async () => {
    const result = await worth_check({ repo: 'o/r', issue_number: 1, npm_package: 'pkg' });
    expect(result.verdict).toBe('SKIP');
    expect(result.disposition).toBe('land_only');
    expect(mocks.linkedWork).toHaveBeenCalled();
    expect(mocks.contribPolicy).toHaveBeenCalled();
    expect(mocks.issueVsMain).not.toHaveBeenCalled();
    expect(mocks.branchScan).not.toHaveBeenCalled();
    expect(mocks.dupeCluster).not.toHaveBeenCalled();
    expect(mocks.releaseGap).not.toHaveBeenCalled();
    expect(result.not_checked.join(' ')).toContain('perf short-circuit');
    expect(result.reasons.join(' ')).toContain('perf short-circuit');
    expect(result.perf.short_circuited).toBe(true);
    expect(result.perf.issue_vs_main_mode).toBe('skipped');
    expect(result.timings_ms.total).toBeGreaterThanOrEqual(0);
    expect(result.timings_ms.phase1).toBeGreaterThanOrEqual(0);
  });

  it('runs expensive checks when linked_work is clean', async () => {
    mocks.linkedWork.mockResolvedValueOnce(createEnvelope({
      verdict_summary: 'no linked pull requests or current assignees found.',
      evidence: [],
      checked: ['mock linked'],
      not_checked: ['mock']
    }));
    mocks.issueVsMain.mockResolvedValueOnce(createEnvelope({
      verdict_summary: 'no evidence on main.',
      evidence: [{ kind: 'issue_vs_main_perf', mode: 'repro_only', clone_cached: null, file_list_cached: null }],
      checked: ['mock issue'],
      not_checked: ['mock']
    }));
    mocks.branchScan.mockResolvedValueOnce(createEnvelope({
      verdict_summary: 'no matching remote branches found.',
      evidence: [{ branch: 'fix-1', tip_fetched: true }],
      checked: ['mock branch'],
      not_checked: ['mock']
    }));
    const result = await worth_check({ repo: 'o/r', issue_number: 1 });
    expect(result.verdict).toBe('ACT');
    expect(mocks.issueVsMain).toHaveBeenCalled();
    expect(mocks.branchScan).toHaveBeenCalled();
    expect(mocks.dupeCluster).toHaveBeenCalled();
    expect(result.perf.short_circuited).toBe(false);
    expect(result.perf.issue_vs_main_mode).toBe('repro_only');
    expect(result.perf.branch_tip_fetches).toBe(1);
    expect(result.timings_ms.phase2).toBeGreaterThanOrEqual(0);
  });
});
