import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../src/core/envelope.js';

const branchScanMock = vi.fn(async () => createEnvelope({
  verdict_summary: 'recent in-flight work found in 1 matching branch.',
  evidence: [{ branch: 'posthog-code/recover-sleep-interrupted-turns', url: 'https://github.com/PostHog/code/tree/posthog-code/recover-sleep-interrupted-turns' }],
  signals: ['in_flight'],
  checked: ['mock branch scan'],
  not_checked: ['fork branches are invisible to this remote branch scan.']
}));

vi.mock('../src/core/branch-scan.js', () => ({ branch_scan: branchScanMock }));
vi.mock('../src/core/issue-vs-main.js', () => ({
  issue_vs_main: vi.fn(async () => createEnvelope({
    verdict_summary: 'partial overlap found.',
    evidence: [{ issue: 2886, title: 'Local tasks break but appear to keep running when laptop sleeps', state: 'open', labels: [], comments: 0, url: 'https://github.com/PostHog/code/issues/2886' }],
    checked: ['mock issue check'],
    not_checked: ["directory or string existence does not prove the issue's intent is satisfied; read both before making any public claim."]
  }))
}));
vi.mock('../src/core/dupe-cluster.js', () => ({ dupe_cluster: vi.fn(async () => createEnvelope({ verdict_summary: 'no lexical duplicate candidates found.', evidence: [], checked: ['mock dupes'], not_checked: ['lexical similarity only; semantic duplicates with different vocabulary will be missed.'] })) }));
vi.mock('../src/core/linked-work.js', () => ({ linked_work: vi.fn(async () => createEnvelope({ verdict_summary: 'no linked pull requests or current assignees found.', evidence: [], checked: ['mock linked work'], not_checked: ['PR linkage depends on GitHub cross-reference events or explicit issue-number mentions; a PR that never mentions the issue number remains invisible.'] })) }));
vi.mock('../src/core/contrib-policy.js', () => ({ contrib_policy: vi.fn(async () => createEnvelope({ verdict_summary: 'no contribution policy signals found.', evidence: [], checked: ['mock policy'], not_checked: ['policy extraction is keyword and heading based; ambiguous sections are reported rather than inferred.'] })) }));

const { worth_check } = await import('../src/core/worth-check.js');

describe('term extraction noise controls', () => {
  it('filters generic title words before branch_scan while preserving the sleep signal', async () => {
    const result = await worth_check({ repo: 'PostHog/code', issue_number: 2886 });
    expect(result.verdict).toBe('SKIP');
    expect(JSON.stringify(result)).toContain('recover-sleep-interrupted-turns');
    expect(branchScanMock).toHaveBeenCalledWith({ repo: 'PostHog/code', keywords: ['laptop', 'sleep'] });
  });
});
