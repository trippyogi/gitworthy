import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockEvidenceItem = Record<string, unknown>;

function scanEnvelope(overrides: { evidence: MockEvidenceItem[]; checked?: string[]; not_checked?: string[]; verdict_summary?: string }) {
  return {
    verdict_summary: overrides.verdict_summary ?? 'mock scan summary',
    evidence: overrides.evidence,
    signals: [],
    checked: overrides.checked ?? ['mock scan checked'],
    not_checked: overrides.not_checked ?? ['mock scan not_checked'],
    cached: false,
    fetched_at: '2026-01-01T00:00:00.000Z'
  };
}

function worthResult(overrides: Partial<{ verdict: string; disposition: string; reasons: string[]; checked: string[]; not_checked: string[] }> = {}) {
  return {
    verdict_summary: 'mock worth_check summary',
    evidence: [],
    signals: [],
    checked: overrides.checked ?? ['linked_work', 'contrib_policy'],
    not_checked: overrides.not_checked ?? ['mock worth_check limitation'],
    cached: false,
    fetched_at: '2026-01-01T00:00:00.000Z',
    verdict: overrides.verdict ?? 'ACT',
    disposition: overrides.disposition ?? 'greenfield',
    reasons: overrides.reasons ?? [],
    sub_results: [],
    timings_ms: {},
    perf: { short_circuited: false, clone_cached: null, file_list_cached: null, branch_tip_fetches: null, issue_vs_main_mode: null }
  };
}

function policyEnvelope(overrides: { signals?: string[]; evidence?: MockEvidenceItem[]; not_checked?: string[] } = {}) {
  return {
    verdict_summary: overrides.signals?.length ? `found ${overrides.signals.length} contribution policy signals.` : 'no contribution policy signals found.',
    evidence: overrides.evidence ?? [],
    signals: overrides.signals ?? [],
    checked: ['mock contrib_policy checked'],
    not_checked: overrides.not_checked ?? ['mock contrib_policy not_checked'],
    cached: false,
    fetched_at: '2026-01-01T00:00:00.000Z'
  };
}

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  orgScan: vi.fn(),
  worthCheck: vi.fn(),
  contribPolicy: vi.fn(),
  getLedgerEntry: vi.fn(async () => null)
}));

vi.mock('../src/core/scan.js', () => ({ scan: mocks.scan }));
vi.mock('../src/core/org-scan.js', () => ({ org_scan: mocks.orgScan }));
vi.mock('../src/core/worth-check.js', () => ({ worth_check: mocks.worthCheck }));
vi.mock('../src/core/contrib-policy.js', () => ({ contrib_policy: mocks.contribPolicy }));
vi.mock('../src/lib/ledger.js', () => ({ getLedgerEntry: mocks.getLedgerEntry }));

const { hunt } = await import('../src/core/hunt.js');
const { GitworthyError } = await import('../src/core/envelope.js');

beforeEach(() => {
  mocks.scan.mockReset();
  mocks.orgScan.mockReset();
  mocks.worthCheck.mockReset();
  mocks.contribPolicy.mockReset();
  mocks.contribPolicy.mockImplementation(async () => policyEnvelope());
  mocks.getLedgerEntry.mockReset();
  mocks.getLedgerEntry.mockImplementation(async () => null);
});

describe('hunt validation', () => {
  it('requires repo or org', async () => {
    await expect(hunt({})).rejects.toBeInstanceOf(GitworthyError);
    await expect(hunt({})).rejects.toMatchObject({ code: 'hunt_invalid_input' });
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(mocks.orgScan).not.toHaveBeenCalled();
  });
});

describe('hunt filtering', () => {
  it('drops likely_land_only, soft_ask, assigned, and ledger-SKIP candidates before checking', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 1, title: 'Clean A', quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 2, title: 'Land only', quality_score: 89, likely_land_only: true, soft_ask: false, assignees: [] },
        { number: 3, title: 'Soft ask', quality_score: 88, likely_land_only: false, soft_ask: true, assignees: [] },
        { number: 4, title: 'Assigned', quality_score: 87, likely_land_only: false, soft_ask: false, assignees: ['dev1'] },
        { number: 5, title: 'Ledger skip', quality_score: 86, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 6, title: 'Clean B', quality_score: 85, likely_land_only: false, soft_ask: false, assignees: [] }
      ]
    }));
    mocks.getLedgerEntry.mockImplementation(async (repo: string, issue_number: number) => {
      if (issue_number === 5) return { repo, issue_number, verdict: 'SKIP', recorded_at: 'x', updated_at: 'x' };
      return null;
    });
    mocks.worthCheck.mockImplementation(async ({ issue_number }: { issue_number: number }) =>
      worthResult({ verdict: 'ACT', disposition: 'greenfield', reasons: [`checked #${issue_number}`] }));

    const result = await hunt({ repo: 'o/r' });

    expect(mocks.worthCheck).toHaveBeenCalledTimes(2);
    expect(mocks.worthCheck.mock.calls.map((call) => call[0].issue_number)).toEqual([1, 6]);

    const candidates = result.evidence.filter((item) => item.kind === 'hunt_candidate');
    expect(candidates.map((item) => item.issue_number)).toEqual([1, 6]);

    const filtered = result.evidence.find((item) => item.kind === 'hunt_filtered');
    expect(filtered).toMatchObject({ count: 4 });
    expect((filtered as Record<string, unknown>).reasons).toEqual(expect.arrayContaining([
      'likely_land_only: 1', 'soft_ask: 1', 'assigned: 1', 'ledger_skip: 1'
    ]));

    expect(result.signals).toEqual([]);
    expect(result.verdict_summary).toContain('hunted 2 checks from 6 scan candidates (4 filtered)');
  });

  it('honors skip_* = false flags to keep candidates that would otherwise be filtered', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 10, title: 'Land only kept', quality_score: 90, likely_land_only: true, soft_ask: false, assignees: [] }
      ]
    }));
    mocks.worthCheck.mockResolvedValue(worthResult());

    const result = await hunt({ repo: 'o/r', skip_likely_land_only: false });
    expect(mocks.worthCheck).toHaveBeenCalledTimes(1);
    expect(result.evidence.some((item) => item.kind === 'hunt_filtered')).toBe(false);
  });

  it('includes land_hint on hunt_candidate evidence when present', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [{ number: 1, quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [], land_hint: 'assigned: dev1' }]
    }));
    mocks.worthCheck.mockResolvedValue(worthResult());
    const result = await hunt({ repo: 'o/r' });
    const candidate = result.evidence.find((item) => item.kind === 'hunt_candidate');
    expect(candidate).toMatchObject({ land_hint: 'assigned: dev1' });
  });
});

describe('hunt max_checks + serial execution', () => {
  it('runs worth_check serially and caps at max_checks', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 1, quality_score: 95, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 2, quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 3, quality_score: 85, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 4, quality_score: 80, likely_land_only: false, soft_ask: false, assignees: [] }
      ]
    }));

    let concurrent = 0;
    let maxConcurrent = 0;
    mocks.worthCheck.mockImplementation(async ({ issue_number }: { issue_number: number }) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return worthResult({ disposition: issue_number === 1 ? 'greenfield' : 'review' });
    });

    const result = await hunt({ repo: 'o/r', max_checks: 2 });

    expect(maxConcurrent).toBe(1);
    expect(mocks.worthCheck).toHaveBeenCalledTimes(2);
    expect(mocks.worthCheck.mock.calls.map((call) => call[0].issue_number)).toEqual([1, 2]);
    expect(result.not_checked.some((item) => item.includes('exceeded max_checks=2') && item.includes('#3') && item.includes('#4'))).toBe(true);
  });

  it('clamps max_checks above 5 down to 5', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: Array.from({ length: 7 }, (_, i) => ({ number: i + 1, quality_score: 100 - i, likely_land_only: false, soft_ask: false, assignees: [] }))
    }));
    mocks.worthCheck.mockResolvedValue(worthResult());
    await hunt({ repo: 'o/r', max_checks: 20 });
    expect(mocks.worthCheck).toHaveBeenCalledTimes(5);
  });

  it('defaults max_checks to 3', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: Array.from({ length: 5 }, (_, i) => ({ number: i + 1, quality_score: 100 - i, likely_land_only: false, soft_ask: false, assignees: [] }))
    }));
    mocks.worthCheck.mockResolvedValue(worthResult());
    await hunt({ repo: 'o/r' });
    expect(mocks.worthCheck).toHaveBeenCalledTimes(3);
  });
});

describe('hunt org mode', () => {
  it('uses org_scan and per-candidate repo when org is provided', async () => {
    mocks.orgScan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 1, repo: 'acme/alpha', quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 2, repo: 'acme/beta', quality_score: 80, likely_land_only: false, soft_ask: false, assignees: [] }
      ]
    }));
    mocks.worthCheck.mockResolvedValue(worthResult());

    const result = await hunt({ org: 'acme', max_checks: 2 });

    expect(mocks.orgScan).toHaveBeenCalledWith(expect.objectContaining({ org: 'acme' }));
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(mocks.worthCheck.mock.calls.map((call) => call[0].repo)).toEqual(['acme/alpha', 'acme/beta']);
    const candidates = result.evidence.filter((item) => item.kind === 'hunt_candidate');
    expect(candidates.map((item) => item.repo)).toEqual(['acme/alpha', 'acme/beta']);
  });

  it('prefers org over repo when both are provided', async () => {
    mocks.orgScan.mockResolvedValue(scanEnvelope({ evidence: [] }));
    await hunt({ repo: 'o/r', org: 'acme' });
    expect(mocks.orgScan).toHaveBeenCalled();
    expect(mocks.scan).not.toHaveBeenCalled();
  });
});

describe('hunt signals and disposition summary', () => {
  it('returns no signals and summarizes dispositions honestly', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 1, quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 2, quality_score: 80, likely_land_only: false, soft_ask: false, assignees: [] }
      ]
    }));
    mocks.worthCheck
      .mockResolvedValueOnce(worthResult({ verdict: 'ACT', disposition: 'greenfield' }))
      .mockResolvedValueOnce(worthResult({ verdict: 'SKIP', disposition: 'blocked' }));

    const result = await hunt({ repo: 'o/r' });
    expect(result.signals).toEqual([]);
    expect(result.verdict_summary).toContain('greenfield x1');
    expect(result.verdict_summary).toContain('blocked x1');
    const candidates = result.evidence.filter((item) => item.kind === 'hunt_candidate');
    expect(candidates[0].worth_check).toMatchObject({ verdict: 'ACT', disposition: 'greenfield' });
    expect(candidates[1].worth_check).toMatchObject({ verdict: 'SKIP', disposition: 'blocked' });
  });

  it('reports no candidates checked honestly when everything is filtered out', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [{ number: 1, quality_score: 90, likely_land_only: true, soft_ask: false, assignees: [] }]
    }));
    const result = await hunt({ repo: 'o/r' });
    expect(mocks.worthCheck).not.toHaveBeenCalled();
    expect(result.evidence.filter((item) => item.kind === 'hunt_candidate')).toHaveLength(0);
    expect(result.verdict_summary).toContain('hunted 0 checks from 1 scan candidate (1 filtered)');
    expect(result.verdict_summary).toContain('none (no candidates checked)');
  });

  it('documents the no-signals design choice in not_checked', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({ evidence: [] }));
    const result = await hunt({ repo: 'o/r' });
    expect(result.not_checked.some((item) => item.includes('hunt is a triage orchestrator') && item.includes('no signals'))).toBe(true);
  });
});

describe('hunt policy gate', () => {
  it('blocks worth_check for a repo whose contrib_policy signals no_pr_path', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 1, quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 2, quality_score: 80, likely_land_only: false, soft_ask: false, assignees: [] }
      ]
    }));
    mocks.contribPolicy.mockResolvedValue(policyEnvelope({
      signals: ['no_pr_path'],
      evidence: [{ category: 'no_pr_path', feedback_channel: 'Discord' }],
      not_checked: ['policy not_checked note for o/r']
    }));

    const result = await hunt({ repo: 'o/r' });

    expect(mocks.contribPolicy).toHaveBeenCalledWith({ repo: 'o/r' });
    expect(mocks.worthCheck).not.toHaveBeenCalled();

    const gateEvidence = result.evidence.find((item) => item.kind === 'policy_gate');
    expect(gateEvidence).toMatchObject({ kind: 'policy_gate', repo: 'o/r', action: 'blocked', signal: 'no_pr_path', feedback_channel: 'Discord' });
    expect(result.evidence.filter((item) => item.kind === 'hunt_candidate')).toHaveLength(0);
    expect(result.checked.some((item) => item.includes('policy_gate') && item.includes('no_pr_path'))).toBe(true);
    expect(result.not_checked).toContain('policy not_checked note for o/r');
    expect(result.not_checked.some((item) => item.includes('blocked by the contrib_policy gate'))).toBe(true);
    expect(result.verdict_summary).toContain('hunted 0 checks');
  });

  it('only blocks the specific repo that signals no_pr_path in org mode, not others', async () => {
    mocks.orgScan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 1, repo: 'acme/blocked', quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 2, repo: 'acme/clear', quality_score: 80, likely_land_only: false, soft_ask: false, assignees: [] }
      ]
    }));
    mocks.contribPolicy.mockImplementation(async ({ repo }: { repo: string }) =>
      repo === 'acme/blocked' ? policyEnvelope({ signals: ['no_pr_path'] }) : policyEnvelope());
    mocks.worthCheck.mockResolvedValue(worthResult());

    const result = await hunt({ org: 'acme', max_checks: 2 });

    expect(mocks.contribPolicy).toHaveBeenCalledTimes(2);
    expect(mocks.worthCheck).toHaveBeenCalledTimes(1);
    expect(mocks.worthCheck).toHaveBeenCalledWith(expect.objectContaining({ repo: 'acme/clear', issue_number: 2 }));

    const candidates = result.evidence.filter((item) => item.kind === 'hunt_candidate');
    expect(candidates.map((item) => item.repo)).toEqual(['acme/clear']);
    const gateEvidence = result.evidence.filter((item) => item.kind === 'policy_gate');
    expect(gateEvidence).toHaveLength(1);
    expect(gateEvidence[0]).toMatchObject({ repo: 'acme/blocked', action: 'blocked' });
  });

  it('backfills worth_check slots when top candidates are policy-blocked', async () => {
    mocks.orgScan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 1, repo: 'acme/blocked', quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 2, repo: 'acme/blocked', quality_score: 85, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 3, repo: 'acme/clear', quality_score: 80, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 4, repo: 'acme/clear2', quality_score: 70, likely_land_only: false, soft_ask: false, assignees: [] }
      ]
    }));
    mocks.contribPolicy.mockImplementation(async ({ repo }: { repo: string }) =>
      repo === 'acme/blocked' ? policyEnvelope({ signals: ['no_pr_path'] }) : policyEnvelope());
    mocks.worthCheck.mockResolvedValue(worthResult());

    const result = await hunt({ org: 'acme', max_checks: 2 });

    expect(mocks.worthCheck).toHaveBeenCalledTimes(2);
    expect(mocks.worthCheck).toHaveBeenNthCalledWith(1, expect.objectContaining({ repo: 'acme/clear', issue_number: 3 }));
    expect(mocks.worthCheck).toHaveBeenNthCalledWith(2, expect.objectContaining({ repo: 'acme/clear2', issue_number: 4 }));
    expect(result.verdict_summary).toContain('hunted 2 checks');
    expect(result.verdict_summary).toContain('2 policy-blocked');
  });

  it('still runs worth_check but prepends a claim_first warning when claim_required', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [{ number: 1, quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] }]
    }));
    mocks.contribPolicy.mockResolvedValue(policyEnvelope({ signals: ['claim_required'] }));
    mocks.worthCheck.mockResolvedValue(worthResult());

    const result = await hunt({ repo: 'o/r' });

    expect(mocks.worthCheck).toHaveBeenCalledTimes(1);
    const gateIndex = result.evidence.findIndex((item) => item.kind === 'policy_gate');
    const candidateIndex = result.evidence.findIndex((item) => item.kind === 'hunt_candidate');
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(candidateIndex).toBeGreaterThan(gateIndex);
    expect(result.evidence[gateIndex]).toMatchObject({ kind: 'policy_gate', repo: 'o/r', action: 'claim_first', signal: 'claim_required' });
    expect(result.checked.some((item) => item.includes('policy_gate warning') && item.includes('claim_required'))).toBe(true);
  });

  it('calls contrib_policy once per unique repo even with multiple candidates from the same repo', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 1, quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 2, quality_score: 80, likely_land_only: false, soft_ask: false, assignees: [] }
      ]
    }));
    mocks.worthCheck.mockResolvedValue(worthResult());

    await hunt({ repo: 'o/r', max_checks: 2 });

    expect(mocks.contribPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.worthCheck).toHaveBeenCalledTimes(2);
  });

  it('skips the policy gate entirely when skip_policy_gate is true', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [{ number: 1, quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] }]
    }));
    mocks.contribPolicy.mockResolvedValue(policyEnvelope({ signals: ['no_pr_path'] }));
    mocks.worthCheck.mockResolvedValue(worthResult());

    const result = await hunt({ repo: 'o/r', skip_policy_gate: true });

    expect(mocks.contribPolicy).not.toHaveBeenCalled();
    expect(mocks.worthCheck).toHaveBeenCalledTimes(1);
    expect(result.evidence.some((item) => item.kind === 'policy_gate')).toBe(false);
    expect(result.checked.some((item) => item.includes('policy gate skipped'))).toBe(true);
  });

  it('does not call contrib_policy when there are no selected candidates', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [{ number: 1, quality_score: 90, likely_land_only: true, soft_ask: false, assignees: [] }]
    }));
    await hunt({ repo: 'o/r' });
    expect(mocks.contribPolicy).not.toHaveBeenCalled();
  });

  it('marks partial when max_checks is exhausted with remaining candidates', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 1, quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 2, quality_score: 80, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 3, quality_score: 70, likely_land_only: false, soft_ask: false, assignees: [] }
      ]
    }));
    mocks.worthCheck.mockResolvedValue(worthResult());
    const result = await hunt({ repo: 'o/r', max_checks: 1 });
    expect(mocks.worthCheck).toHaveBeenCalledTimes(1);
    const run = result.evidence.find((item) => item.kind === 'hunt_run');
    expect(run).toMatchObject({ status: 'partial' });
    expect(String(run?.partial_reason ?? '')).toMatch(/max_checks/);
    expect(result.not_checked.join(' ')).toMatch(/exceeded max_checks/);
  });

  it('stops and preserves partial progress when signal aborts before the next check', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope({
      evidence: [
        { number: 1, quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] },
        { number: 2, quality_score: 80, likely_land_only: false, soft_ask: false, assignees: [] }
      ]
    }));
    const abort = new AbortController();
    mocks.worthCheck.mockImplementation(async () => {
      abort.abort();
      return worthResult();
    });
    const result = await hunt({ repo: 'o/r', max_checks: 5, signal: abort.signal });
    expect(mocks.worthCheck).toHaveBeenCalledTimes(1);
    const run = result.evidence.find((item) => item.kind === 'hunt_run');
    expect(run).toMatchObject({ status: 'partial', partial_reason: 'cancelled' });
    expect(result.not_checked.join(' ')).toMatch(/cancelled/);
    expect(result.not_checked.join(' ')).not.toMatch(/exceeded max_checks/);
  });
});
