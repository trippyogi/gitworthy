import { describe, expect, it } from 'vitest';
import { decideFromSignals } from '../src/decision/policy.js';

/** GW-036: mutation guards for hard-SKIP / heuristic invariants. */

describe('decideFromSignals hard-SKIP invariants', () => {
  it('never SKIPs from heuristic-only signals', () => {
    const decision = decideFromSignals({
      signals: ['duplicate', 'needs_repro'],
      sub_results: [{
        name: 'dupe_cluster',
        ok: true,
        result: { signals: ['duplicate'], evidence: [{ kind: 'dupe', score: 0.4 }] }
      }],
      errors: [],
      priorAttempts: 0,
      referencedCommits: 0,
      networkPrs: 0
    });
    expect(decision.verdict).not.toBe('SKIP');
    expect(decision.findings.every((item) => item.strength !== 'definitive' || item.effect !== 'block')).toBe(true);
  });

  it('SKIPs only when a definitive block finding is present (released_fix)', () => {
    const decision = decideFromSignals({
      signals: ['released_fix'],
      sub_results: [{
        name: 'release_gap',
        ok: true,
        result: { signals: ['released_fix'], evidence: [{ kind: 'release', version: '1.2.3' }] }
      }],
      errors: [],
      priorAttempts: 0,
      referencedCommits: 0,
      networkPrs: 0
    });
    expect(decision.verdict).toBe('SKIP');
    expect(decision.findings.some((item) => item.strength === 'definitive' && item.effect === 'block')).toBe(true);
  });

  it('caps mandatory provider failures at VERIFY, never SKIP', () => {
    const decision = decideFromSignals({
      signals: [],
      sub_results: [],
      errors: [{
        name: 'linked_work',
        ok: false,
        error: { code: 'http_error', message: 'rate limited', not_checked: ['linked_work'] }
      }],
      priorAttempts: 0,
      referencedCommits: 0,
      networkPrs: 0
    });
    expect(decision.verdict).toBe('VERIFY');
  });

  it('open closing PR yields land_only SKIP path via definitive linked evidence', () => {
    const decision = decideFromSignals({
      signals: ['linked_pr_open'],
      sub_results: [{
        name: 'linked_work',
        ok: true,
        result: {
          signals: ['linked_pr_open'],
          evidence: [{
            kind: 'linked_pr',
            state: 'open',
            number: 99,
            closes_issue: true,
            draft: false,
            html_url: 'https://github.com/o/r/pull/99',
            updated_at: '2026-08-01T00:00:00Z'
          }]
        }
      }],
      errors: [],
      priorAttempts: 0,
      referencedCommits: 0,
      networkPrs: 1
    });
    expect(decision.verdict).toBe('SKIP');
    expect(decision.disposition).toBe('land_only');
  });
});
