import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockEvidenceItem = Record<string, unknown>;

function scanEnvelope(evidence: MockEvidenceItem[]) {
  return {
    verdict_summary: 'mock scan summary',
    evidence,
    signals: [],
    checked: ['mock scan checked'],
    not_checked: ['mock scan not_checked'],
    cached: false,
    fetched_at: '2026-01-01T00:00:00.000Z'
  };
}

function worthResult(overrides: Partial<{ verdict: string; disposition: string; reasons: string[] }> = {}) {
  return {
    verdict_summary: 'mock worth_check summary',
    evidence: [],
    signals: [],
    checked: [],
    not_checked: ['mock worth_check limitation'],
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

function policyEnvelope() {
  return {
    verdict_summary: 'no contribution policy signals found.',
    evidence: [],
    signals: [],
    checked: ['mock contrib_policy checked'],
    not_checked: ['mock contrib_policy not_checked'],
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

beforeEach(() => {
  mocks.scan.mockReset();
  mocks.orgScan.mockReset();
  mocks.worthCheck.mockReset();
  mocks.contribPolicy.mockReset();
  mocks.contribPolicy.mockImplementation(async () => policyEnvelope());
  mocks.getLedgerEntry.mockReset();
  mocks.getLedgerEntry.mockImplementation(async () => null);
});

describe('hunt skill_profile', () => {
  it('passes skill_profile through to scan', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope([]));
    await hunt({ repo: 'o/r', skill_profile: { languages: ['typescript'] } });
    expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({ skill_profile: { languages: ['typescript'] } }));
  });

  it('passes skill_profile through to org_scan', async () => {
    mocks.orgScan.mockResolvedValue(scanEnvelope([]));
    await hunt({ org: 'acme', skill_profile: 'languages=go' });
    expect(mocks.orgScan).toHaveBeenCalledWith(expect.objectContaining({ skill_profile: 'languages=go' }));
  });

  it('includes fit_score on hunt_candidate evidence when scan provided it', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope([
      { number: 1, quality_score: 90, fit_score: 0.65, likely_land_only: false, soft_ask: false, assignees: [] }
    ]));
    mocks.worthCheck.mockResolvedValue(worthResult());

    const result = await hunt({ repo: 'o/r', skill_profile: { languages: ['typescript'] } });

    const candidate = result.evidence.find((item) => item.kind === 'hunt_candidate');
    expect(candidate).toMatchObject({ issue_number: 1, fit_score: 0.65 });
  });

  it('omits fit_score from hunt_candidate evidence when no skill_profile was used', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope([
      { number: 1, quality_score: 90, likely_land_only: false, soft_ask: false, assignees: [] }
    ]));
    mocks.worthCheck.mockResolvedValue(worthResult());

    const result = await hunt({ repo: 'o/r' });

    const candidate = result.evidence.find((item) => item.kind === 'hunt_candidate');
    expect(candidate).not.toHaveProperty('fit_score');
  });

  it('prefers higher fit_score among candidates that tie on quality_score when selecting max_checks', async () => {
    mocks.scan.mockResolvedValue(scanEnvelope([
      { number: 1, quality_score: 90, fit_score: 0.4, likely_land_only: false, soft_ask: false, assignees: [] },
      { number: 2, quality_score: 90, fit_score: 0.9, likely_land_only: false, soft_ask: false, assignees: [] },
      { number: 3, quality_score: 80, fit_score: 0.99, likely_land_only: false, soft_ask: false, assignees: [] }
    ]));
    mocks.worthCheck.mockResolvedValue(worthResult());

    await hunt({ repo: 'o/r', skill_profile: { languages: ['typescript'] }, max_checks: 2 });

    expect(mocks.worthCheck.mock.calls.map((call) => call[0].issue_number)).toEqual([2, 1]);
  });
});
