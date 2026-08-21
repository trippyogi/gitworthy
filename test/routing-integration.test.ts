import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Signal } from '../src/core/envelope.js';
import { DecisionRecordSchema } from '../src/contracts/store.js';
import { toCheckResult } from '../src/contracts/serialize.js';
import { stateFingerprint } from '../src/lib/state-fingerprint.js';

const mocks = vi.hoisted(() => ({
  branchSignals: [] as Signal[],
  dupeSignals: [] as Signal[],
  linkedSignals: [] as Signal[],
  linkedError: null as Error | null,
  linkedEvidence: [] as Array<Record<string, unknown>>,
  releaseSignals: [] as Signal[],
  policySignals: [] as Signal[],
  issueSignals: [] as Signal[]
}));

function envelope(signals: Signal[] = [], evidence: Array<Record<string, unknown>> = []) {
  return createEnvelope({
    verdict_summary: signals.length > 0 ? `${signals.join(', ')} found.` : 'no signals found.',
    evidence,
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
    return envelope(mocks.linkedSignals, mocks.linkedEvidence);
  })
}));
vi.mock('../src/core/release-gap.js', () => ({ release_gap: vi.fn(async () => envelope(mocks.releaseSignals)) }));
vi.mock('../src/core/contrib-policy.js', () => ({ contrib_policy: vi.fn(async () => envelope(mocks.policySignals)) }));

const { worth_check } = await import('../src/core/worth-check.js');

describe('worth_check routing integration', () => {
  beforeEach(() => {
    mocks.branchSignals = [];
    mocks.dupeSignals = [];
    mocks.linkedSignals = [];
    mocks.linkedError = null;
    mocks.linkedEvidence = [];
    mocks.releaseSignals = [];
    mocks.policySignals = [];
    mocks.issueSignals = [];
  });

  it('attaches BUILD routing to ACT / greenfield without changing the verdict', async () => {
    const result = await worth_check({ repo: 'o/r', issue_number: 1 });
    expect(result.verdict).toBe('ACT');
    expect(result.disposition).toBe('greenfield');
    expect(result.routing?.primary_mode).toBe('BUILD');
    expect(result.routing?.build_contention).toBe('GREEN');
    expect(result.source_snapshot?.state_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps SKIP / land_only and routes REVIEW after a definitive closer short-circuit', async () => {
    mocks.linkedSignals = ['linked_pr_open'];
    mocks.linkedEvidence = [{
      kind: 'linked_pr',
      number: 99,
      state: 'open',
      closes_issue: true,
      source: 'timeline',
      url: 'https://github.com/o/r/pull/99'
    }];
    const result = await worth_check({ repo: 'o/r', issue_number: 1 });
    expect(result.verdict).toBe('SKIP');
    expect(result.disposition).toBe('land_only');
    expect(result.perf.short_circuited).toBe(true);
    expect(result.routing?.primary_mode).toBe('REVIEW');
    expect(result.routing?.build_contention).toBe('RED');
    expect(result.routing?.primary_mode).not.toBe('BUILD');
    expect(result.routing?.primary_mode).not.toBe('PASS');
  });

  it('routes assigned issues to WATCH without changing VERIFY', async () => {
    mocks.linkedSignals = ['assigned'];
    mocks.linkedEvidence = [{ kind: 'assignment', assignee: 'maintainer' }];
    const result = await worth_check({ repo: 'o/r', issue_number: 1 });
    expect(result.verdict).toBe('VERIFY');
    expect(result.disposition).toBe('claim_first');
    expect(result.routing?.primary_mode).toBe('WATCH');
  });

  it('routes needs_repro to REPRODUCE while keeping VERIFY', async () => {
    mocks.issueSignals = ['needs_repro'];
    const result = await worth_check({ repo: 'o/r', issue_number: 1 });
    expect(result.verdict).toBe('VERIFY');
    expect(result.routing?.primary_mode).toBe('REPRODUCE');
  });

  it('keeps provider failure at low-confidence non-BUILD', async () => {
    mocks.linkedError = new Error('GitHub API rate limited');
    const result = await worth_check({ repo: 'o/r', issue_number: 1 });
    expect(result.verdict).toBe('VERIFY');
    expect(result.routing?.primary_mode).not.toBe('BUILD');
    expect(result.routing?.confidence).toBe('low');
  });

  it('preserves routing through toCheckResult and durable records without routing still parse', () => {
    const check = toCheckResult({
      verdict_summary: 'no blocking evidence found by completed checks.',
      evidence: [],
      signals: [],
      checked: ['linked_work'],
      not_checked: ['n/a'],
      cached: false,
      fetched_at: '2026-01-01T00:00:00.000Z',
      verdict: 'ACT',
      disposition: 'greenfield',
      routing: {
        routing_version: 1,
        primary_mode: 'BUILD',
        alternate_modes: [],
        build_contention: 'GREEN',
        confidence: 'high',
        reasons: ['ACT / greenfield'],
        hard_constraints: [],
        next_actions: [{ kind: 'proceed', message: 'Re-check before a public action.' }],
        evidenceability: { score: 0.5, reasons: ['no bug/repro signal'] },
        effort_bucket: 'unknown',
        coverage: {
          mandatory_checks_complete: true,
          failed_checks: [],
          skipped_checks: [],
          budget_truncated: false,
          rate_limit_degraded: false,
          advisory_missing: []
        }
      },
      source_snapshot: {
        observed_at: '2026-01-01T00:00:00.000Z',
        linked_prs: [],
        state_fingerprint: 'a'.repeat(64)
      }
    }, { repo: 'o/r', issue_number: 9 });
    expect(check.routing?.primary_mode).toBe('BUILD');
    expect(check.source_snapshot?.state_fingerprint).toHaveLength(64);

    const legacy = DecisionRecordSchema.parse({
      record_version: 1,
      record_kind: 'decision',
      decision_id: 'decision_legacy',
      run_id: 'run_legacy',
      gitworthy_version: '0.4.1',
      created_at: '2026-01-01T00:00:00.000Z',
      target: { input_repo: 'o/r', canonical_repo: 'o/r', issue_number: 1 },
      verdict: 'ACT',
      disposition: 'greenfield'
    });
    expect(legacy.routing).toBeUndefined();
    expect(legacy.source_snapshot).toBeUndefined();
  });
});

describe('stateFingerprint', () => {
  it('is stable after sorting assignees and linked PRs', () => {
    const left = stateFingerprint({
      repo: 'o/r',
      issue_number: 3,
      issue_state: 'open',
      assignees: ['Zoe', 'amy'],
      linked_prs: [
        { number: 2, state: 'open', closes_issue: false },
        { number: 1, state: 'open', closes_issue: true }
      ],
      contribution_policy: { claim_required: false, no_pr_path: false }
    });
    const right = stateFingerprint({
      repo: 'o/r',
      issue_number: 3,
      issue_state: 'open',
      assignees: ['amy', 'Zoe'],
      linked_prs: [
        { number: 1, state: 'open', closes_issue: true },
        { number: 2, state: 'open', closes_issue: false }
      ]
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when linked PR state changes', () => {
    const base = {
      repo: 'o/r',
      issue_number: 3,
      linked_prs: [{ number: 1, state: 'open', closes_issue: true }]
    };
    const open = stateFingerprint(base);
    const closed = stateFingerprint({
      ...base,
      linked_prs: [{ number: 1, state: 'closed', closes_issue: true }]
    });
    expect(open).not.toBe(closed);
  });
});
