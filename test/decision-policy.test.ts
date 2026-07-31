import { describe, expect, it } from 'vitest';
import { decideFromSignals } from '../src/decision/policy.js';
import type { Signal } from '../src/core/envelope.js';

function decide(signals: Signal[], sub_results: Parameters<typeof decideFromSignals>[0]['sub_results'] = [], errors: Parameters<typeof decideFromSignals>[0]['errors'] = []) {
  return decideFromSignals({
    signals,
    sub_results,
    errors,
    priorAttempts: 0,
    referencedCommits: 0,
    networkPrs: 0
  });
}

describe('decideFromSignals', () => {
  it('caps lexical duplicate at VERIFY', () => {
    const decision = decide(['duplicate']);
    expect(decision.verdict).toBe('VERIFY');
    expect(decision.disposition).toBe('review');
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'lexical_duplicate', strength: 'heuristic', effect: 'verify' })
    ]));
  });

  it('caps shipped at VERIFY', () => {
    const decision = decide(['shipped']);
    expect(decision.verdict).toBe('VERIFY');
    expect(decision.disposition).toBe('review');
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'path_or_content_overlap', strength: 'heuristic', effect: 'verify' })
    ]));
  });

  it('caps in_flight at VERIFY', () => {
    const decision = decide(['in_flight']);
    expect(decision.verdict).toBe('VERIFY');
    expect(decision.disposition).toBe('review');
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'branch_match', strength: 'heuristic', effect: 'verify' })
    ]));
  });

  it('caps title_overlap open PRs at VERIFY', () => {
    const decision = decide(['linked_pr_open'], [{
      name: 'linked_work',
      ok: true,
      result: {
        signals: ['linked_pr_open'],
        evidence: [{
          kind: 'linked_pr',
          number: 42,
          state: 'open',
          source: 'title_overlap',
          closes_issue: false,
          url: 'https://github.com/o/r/pull/42'
        }]
      }
    }]);
    expect(decision.verdict).toBe('VERIFY');
    expect(decision.disposition).toBe('review');
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'title_overlap_pr', strength: 'heuristic', effect: 'verify' })
    ]));
  });

  it('maps explicit closes open PRs to SKIP / land_only', () => {
    const decision = decide(['linked_pr_open'], [{
      name: 'linked_work',
      ok: true,
      result: {
        signals: ['linked_pr_open'],
        evidence: [{
          kind: 'linked_pr',
          number: 99,
          state: 'open',
          source: 'timeline',
          closes_issue: true,
          url: 'https://github.com/o/r/pull/99'
        }]
      }
    }]);
    expect(decision.verdict).toBe('SKIP');
    expect(decision.disposition).toBe('land_only');
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'linked_pr_open', strength: 'definitive', effect: 'block' })
    ]));
  });

  it('maps linked_pr_merged to CLOSE_CANDIDATE VERIFY', () => {
    const decision = decide(['linked_pr_merged']);
    expect(decision.verdict).toBe('VERIFY');
    expect(decision.disposition).toBe('review');
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'close_candidate', strength: 'definitive', effect: 'verify' })
    ]));
  });

  it('ranks competing open closers and informs on siblings', () => {
    const decision = decide(['linked_pr_open'], [{
      name: 'linked_work',
      ok: true,
      result: {
        signals: ['linked_pr_open'],
        evidence: [
          {
            kind: 'linked_pr',
            number: 10,
            state: 'open',
            source: 'timeline',
            closes_issue: true,
            draft: false,
            date: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            url: 'https://github.com/o/r/pull/10'
          },
          {
            kind: 'linked_pr',
            number: 20,
            state: 'open',
            source: 'timeline',
            closes_issue: true,
            draft: false,
            date: '2025-01-01T00:00:00Z',
            updated_at: '2026-07-01T00:00:00Z',
            url: 'https://github.com/o/r/pull/20'
          }
        ]
      }
    }]);
    expect(decision.verdict).toBe('SKIP');
    expect(decision.disposition).toBe('land_only');
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'linked_pr_open',
        data: expect.objectContaining({ number: 20, land_pick: true })
      }),
      expect.objectContaining({
        type: 'competing_open_closer',
        effect: 'inform',
        data: expect.objectContaining({ number: 10, primary: 20 })
      })
    ]));
  });

  it('ignores draft-without-close evidence for definitive land_only', () => {
    const decision = decide(['linked_pr_open'], [{
      name: 'linked_work',
      ok: true,
      result: {
        signals: ['linked_pr_open'],
        evidence: [{
          kind: 'linked_pr',
          number: 7,
          state: 'open',
          source: 'search',
          closes_issue: false,
          draft: true,
          ignored_reason: 'draft_without_close',
          url: 'https://github.com/o/r/pull/7'
        }]
      }
    }]);
    expect(decision.verdict).toBe('VERIFY');
    expect(decision.findings.some((item) => item.type === 'linked_pr_open' && item.strength === 'definitive')).toBe(false);
  });

  it('caps provider errors at VERIFY', () => {
    const errors = [{
      name: 'linked_work',
      ok: false as const,
      error: { code: 'github_error', message: 'API unavailable', not_checked: ['linked work'] }
    }];
    const decision = decide([], [], errors);
    expect(decision.verdict).toBe('VERIFY');
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'mandatory_check_failed', strength: 'definitive', effect: 'verify' })
    ]));
  });

  it('caps at VERIFY when a definitive blocker coexists with a provider error', () => {
    const errors = [{
      name: 'linked_work',
      ok: false as const,
      error: { code: 'github_error', message: 'API unavailable', not_checked: ['linked work'] }
    }];
    const decision = decide(['released_fix'], [{
      name: 'release_gap',
      ok: true,
      result: { signals: ['released_fix'], evidence: [] }
    }], errors);
    expect(decision.verdict).toBe('VERIFY');
  });

  it('does not invent definitive SKIP without classified open-PR evidence', () => {
    const decision = decide(['linked_pr_open']);
    expect(decision.verdict).toBe('VERIFY');
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'linked_pr_open_unclassified', strength: 'heuristic', effect: 'verify' })
    ]));
  });
});
