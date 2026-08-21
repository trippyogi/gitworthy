import { describe, expect, it } from 'vitest';
import { computeCapacity, portfolio } from '../src/core/portfolio.js';
import { GENERIC_CONTRIBUTION_PROFILE } from '../src/core/contribution-profile.js';
import type { OutcomeEvent } from '../src/contracts/outcomes.js';

function outcome(overrides: Partial<OutcomeEvent> & { event: OutcomeEvent['event'] }): OutcomeEvent {
  return {
    event_version: 1,
    event_id: overrides.event_id ?? `evt-${overrides.event}`,
    decision_id: 'dec-1',
    run_id: 'run-1',
    target: overrides.target ?? { repo: 'o/r', issue_number: 1 },
    event: overrides.event,
    occurred_at: overrides.occurred_at ?? '2026-08-01T00:00:00.000Z',
    source: 'test',
    data: overrides.data ?? {},
    notes: '',
    ...overrides
  };
}

describe('portfolio capacity and dispatch', () => {
  it('counts unresolved selected/pr_opened as active BUILD when mode is missing', () => {
    const capacity = computeCapacity([
      outcome({ event: 'selected', occurred_at: '2026-08-01T00:00:00.000Z' }),
      outcome({ event: 'pr_opened', occurred_at: '2026-08-02T00:00:00.000Z', target: { repo: 'o/r', issue_number: 2 } })
    ], GENERIC_CONTRIBUTION_PROFILE);
    expect(capacity.used.BUILD).toBe(2);
    expect(capacity.confidence).toBe('low');
  });

  it('clears a slot after a terminal event', () => {
    const capacity = computeCapacity([
      outcome({ event: 'selected', occurred_at: '2026-08-01T00:00:00.000Z' }),
      outcome({ event: 'merged', occurred_at: '2026-08-03T00:00:00.000Z' })
    ], GENERIC_CONTRIBUTION_PROFILE);
    expect(capacity.used.BUILD ?? 0).toBe(0);
  });

  it('queues BUILD when WIP is full without rewriting primary_mode', async () => {
    const result = await portfolio({ repo: 'o/r', include_prs: false, max_items: 5 }, {
      hunt: async () => ({
        verdict_summary: 'hunt',
        evidence: [{
          kind: 'hunt_candidate',
          repo: 'o/r',
          issue_number: 9,
          title: 'Fix crash',
          worth_check: {
            verdict: 'ACT',
            disposition: 'greenfield',
            findings: [],
            routing: {
              routing_version: 1,
              primary_mode: 'BUILD',
              alternate_modes: [],
              build_contention: 'GREEN',
              confidence: 'high',
              reasons: ['greenfield'],
              hard_constraints: [],
              next_actions: [],
              evidenceability: { score: 0.9, reasons: ['repro'] },
              effort_bucket: 'fast',
              coverage: {
                mandatory_checks_complete: true,
                failed_checks: [],
                skipped_checks: [],
                budget_truncated: false,
                rate_limit_degraded: false,
                advisory_missing: []
              }
            }
          }
        }],
        signals: [],
        checked: ['hunt'],
        not_checked: ['none'],
        cached: false,
        fetched_at: '2026-08-01T00:00:00.000Z'
      }),
      listOutcomes: async () => [
        outcome({ event: 'selected', data: { contribution_mode: 'BUILD' } }),
        outcome({ event: 'pr_opened', target: { repo: 'o/r', issue_number: 2 }, data: { contribution_mode: 'BUILD' } })
      ]
    });
    expect(result.items[0]?.primary_mode).toBe('BUILD');
    expect(result.items[0]?.dispatch_state).toBe('queued_by_capacity');
    expect(result.items[0]?.verdict).toBe('ACT');
    expect(result).not.toHaveProperty('verdict');
  });

  it('never keeps BUILD on a definitive closer and does not mutate verdict', async () => {
    const result = await portfolio({ repo: 'o/r', include_prs: false }, {
      hunt: async () => ({
        verdict_summary: 'hunt',
        evidence: [{
          kind: 'hunt_candidate',
          repo: 'o/r',
          issue_number: 4,
          title: 'Already claimed',
          worth_check: {
            verdict: 'SKIP',
            disposition: 'land_only',
            findings: [{ type: 'linked_pr_open', strength: 'definitive', message: 'PR #3 closes this' }],
            routing: {
              routing_version: 1,
              primary_mode: 'BUILD',
              alternate_modes: [],
              build_contention: 'RED',
              confidence: 'high',
              reasons: ['closer'],
              hard_constraints: [],
              next_actions: [],
              evidenceability: { score: 0.4, reasons: [] },
              effort_bucket: 'unknown',
              coverage: {
                mandatory_checks_complete: true,
                failed_checks: [],
                skipped_checks: [],
                budget_truncated: false,
                rate_limit_degraded: false,
                advisory_missing: []
              }
            }
          }
        }],
        signals: [],
        checked: ['hunt'],
        not_checked: ['none'],
        cached: false,
        fetched_at: '2026-08-01T00:00:00.000Z'
      }),
      listOutcomes: async () => []
    });
    expect(result.items[0]?.verdict).toBe('SKIP');
    expect(result.items[0]?.primary_mode).not.toBe('BUILD');
    expect(result.items[0]?.dispatch_state).toBe('blocked_by_constraint');
  });

  it('scopes org capacity to hunt candidate repos only', async () => {
    const result = await portfolio({ org: 'acme', include_prs: false, max_items: 5 }, {
      hunt: async () => ({
        verdict_summary: 'hunt',
        evidence: [{
          kind: 'hunt_candidate',
          repo: 'acme/one',
          issue_number: 1,
          title: 'Fix crash',
          worth_check: {
            verdict: 'ACT',
            disposition: 'greenfield',
            findings: [],
            routing: {
              routing_version: 1,
              primary_mode: 'BUILD',
              alternate_modes: [],
              build_contention: 'GREEN',
              confidence: 'high',
              reasons: ['greenfield'],
              hard_constraints: [],
              next_actions: [],
              evidenceability: { score: 0.9, reasons: [] },
              effort_bucket: 'fast',
              coverage: {
                mandatory_checks_complete: true,
                failed_checks: [],
                skipped_checks: [],
                budget_truncated: false,
                rate_limit_degraded: false,
                advisory_missing: []
              }
            }
          }
        }],
        signals: [],
        checked: ['hunt'],
        not_checked: ['none'],
        cached: false,
        fetched_at: '2026-08-01T00:00:00.000Z'
      }),
      listOutcomes: async () => [
        outcome({ event: 'selected', target: { repo: 'other/x', issue_number: 9 }, data: { contribution_mode: 'BUILD' } }),
        outcome({ event: 'pr_opened', target: { repo: 'other/y', issue_number: 8 }, data: { contribution_mode: 'BUILD' } })
      ]
    });
    expect(result.capacity.used.BUILD ?? 0).toBe(0);
    expect(result.items[0]?.dispatch_state).toBe('ready');
  });

  it('rejects repo and org together', async () => {
    await expect(portfolio({ repo: 'o/r', org: 'acme' })).rejects.toMatchObject({
      code: 'portfolio_invalid_input'
    });
  });
});
