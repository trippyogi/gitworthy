import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Signal } from '../src/core/envelope.js';

const mocks = vi.hoisted(() => ({
  branchSignals: [] as Signal[],
  dupeSignals: [] as Signal[],
  linkedSignals: [] as Signal[],
  linkedError: null as Error | null,
  releaseSignals: [] as Signal[],
  policySignals: [] as Signal[],
  issueSignals: [] as Signal[]
}));

function envelope(signals: Signal[] = []) {
  return createEnvelope({
    verdict_summary: signals.length > 0 ? `${signals.join(', ')} found.` : 'no signals found.',
    evidence: signals.includes('linked_pr_open') ? [{ kind: 'linked_pr', number: 123, state: 'open', url: 'https://github.com/o/r/pull/123' }] : signals.includes('linked_pr_merged') ? [{ kind: 'linked_pr', number: 124, merged: true, url: 'https://github.com/o/r/pull/124' }] : signals.includes('linked_pr_closed') ? [{ kind: 'linked_pr', number: 528, state: 'closed', merged: false, url: 'https://github.com/o/r/pull/528' }] : signals.includes('assigned') ? [{ kind: 'assignment', assignee: 'maintainer', assigned_at: '2026-01-01T00:00:00Z' }] : signals.includes('claim_required') ? [{ category: 'claim_required', excerpt: 'please request assignment before opening a PR' }] : [],
    signals,
    checked: ['mock check'],
    not_checked: ['mock limitation']
  });
}

vi.mock('../src/core/issue-vs-main.js', () => ({
  issue_vs_main: vi.fn(async () => createEnvelope({
    verdict_summary: mocks.issueSignals.length > 0 ? `${mocks.issueSignals.join(', ')} found.` : 'target issue fetched.',
    evidence: [{ title: 'Windows agent domain iframe task' }],
    signals: mocks.issueSignals,
    checked: ['mock issue'],
    not_checked: ['mock issue limitation']
  }))
}));
vi.mock('../src/core/branch-scan.js', () => ({ branch_scan: vi.fn(async () => envelope(mocks.branchSignals)) }));
vi.mock('../src/core/dupe-cluster.js', () => ({ dupe_cluster: vi.fn(async () => envelope(mocks.dupeSignals)) }));
vi.mock('../src/core/linked-work.js', () => ({
  linked_work: vi.fn(async () => {
    if (mocks.linkedError) throw mocks.linkedError;
    return envelope(mocks.linkedSignals);
  })
}));
vi.mock('../src/core/release-gap.js', () => ({ release_gap: vi.fn(async () => envelope(mocks.releaseSignals)) }));
vi.mock('../src/core/contrib-policy.js', () => ({ contrib_policy: vi.fn(async () => envelope(mocks.policySignals)) }));

const { worth_check } = await import('../src/core/worth-check.js');

describe('worth_check authority hierarchy', () => {
  beforeEach(() => {
    mocks.branchSignals = [];
    mocks.dupeSignals = [];
    mocks.linkedSignals = [];
    mocks.linkedError = null;
    mocks.releaseSignals = [];
    mocks.policySignals = [];
    mocks.issueSignals = [];
  });

  it('caps branch-only in_flight at VERIFY when linked_work completed cleanly', async () => {
    mocks.branchSignals = ['in_flight'];

    const result = await worth_check({ repo: 'o/r', issue_number: 1 });

    expect(result.verdict).toBe('VERIFY');
    expect(result.signals).toEqual(['in_flight']);
    expect(result.disposition).toBe('review');
    expect(result.reasons.join(' ')).toContain('Matching branch names are heuristic');
  });

  it('keeps VERIFY when linked_work cannot verify authority for in_flight', async () => {
    mocks.branchSignals = ['in_flight'];
    mocks.linkedError = new Error('GitHub API unavailable');

    const result = await worth_check({ repo: 'o/r', issue_number: 1 });

    expect(result.verdict).toBe('VERIFY');
    expect(result.reasons.join(' ')).toContain('linked_work errored');
    expect(result.reasons.join(' ')).toContain('Matching branch names are heuristic');
  });

  it.each([
    ['duplicate', 'VERIFY', 'review'],
    ['shipped', 'VERIFY', 'review'],
    ['released_fix', 'SKIP', 'blocked'],
    ['linked_pr_open', 'VERIFY', 'review'],
    ['linked_pr_merged', 'VERIFY', 'review'],
    ['linked_pr_closed', 'VERIFY', 'review'],
    ['assigned', 'VERIFY', 'claim_first'],
    ['no_pr_path', 'VERIFY', 'blocked'],
    ['needs_repro', 'VERIFY', 'review'],
    ['claim_required', 'VERIFY', 'claim_first']
  ] as Array<[Signal, 'SKIP' | 'VERIFY', string]>)('maps %s to %s / %s', async (signal, expected, disposition) => {
    if (signal === 'duplicate') mocks.dupeSignals = [signal];
    else if (signal === 'released_fix') mocks.releaseSignals = [signal];
    else if (signal === 'linked_pr_open' || signal === 'linked_pr_merged' || signal === 'linked_pr_closed' || signal === 'assigned') mocks.linkedSignals = [signal];
    else if (signal === 'no_pr_path' || signal === 'claim_required') mocks.policySignals = [signal];
    else if (signal === 'shipped' || signal === 'needs_repro') mocks.issueSignals = [signal];
    else mocks.branchSignals = [signal];

    const result = await worth_check({ repo: 'o/r', issue_number: 1, npm_package: 'pkg' });

    expect(result.verdict).toBe(expected);
    expect(result.signals).toContain(signal);
    expect(result.disposition).toBe(disposition);
    if (signal === 'claim_required') expect(result.reasons.join(' ')).toContain('claiming or assignment');
    if (signal === 'needs_repro') expect(result.reasons.join(' ')).toContain('lacks reproduction steps');
    if (signal === 'linked_pr_open') expect(result.reasons.join(' ')).toContain('mentions the issue');
  });

  it('keeps heuristics at VERIFY even when in_flight and duplicate coincide', async () => {
    mocks.branchSignals = ['in_flight'];
    mocks.dupeSignals = ['duplicate'];

    const result = await worth_check({ repo: 'o/r', issue_number: 1 });

    expect(result.verdict).toBe('VERIFY');
    expect(result.disposition).toBe('review');
    expect(result.signals).toEqual(['in_flight', 'duplicate']);
  });

  it('maps explicit closing open PR evidence to SKIP / land_only', async () => {
    mocks.linkedSignals = ['linked_pr_open'];
    const { linked_work } = await import('../src/core/linked-work.js');
    vi.mocked(linked_work).mockResolvedValueOnce(createEnvelope({
      verdict_summary: 'found 1 linked pull request.',
      evidence: [{ kind: 'linked_pr', number: 99, state: 'open', closes_issue: true, source: 'timeline', url: 'https://github.com/o/r/pull/99' }],
      signals: ['linked_pr_open'],
      checked: ['mock linked'],
      not_checked: ['mock']
    }));

    const result = await worth_check({ repo: 'o/r', issue_number: 1 });

    expect(result.verdict).toBe('SKIP');
    expect(result.disposition).toBe('land_only');
    expect(result.reasons.join(' ')).toContain('explicitly closes');
  });
});
