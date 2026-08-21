import { describe, expect, it } from 'vitest';
import { RoutingDecisionSchema, type RouteFacts, type RouteLinkedFacts, type RoutingCoverage } from '../src/contracts/routing.js';
import { routeContribution } from '../src/decision/contribution-route.js';
import type { Finding } from '../src/contracts/findings.js';

function coverage(overrides: Partial<RoutingCoverage> = {}): RoutingCoverage {
  return {
    mandatory_checks_complete: true,
    failed_checks: [],
    skipped_checks: [],
    budget_truncated: false,
    rate_limit_degraded: false,
    advisory_missing: [],
    ...overrides
  };
}

function linked(overrides: Partial<RouteLinkedFacts> = {}): RouteLinkedFacts {
  return {
    activeClosers: 0,
    activeRelatedPrs: 0,
    closedUnmergedAttempts: 0,
    mergedClosers: 0,
    assigned: false,
    claimRequired: false,
    ...overrides
  };
}

function finding(type: string, extras: Partial<Finding> = {}): Finding {
  return {
    id: extras.id ?? `finding_${type}`,
    type,
    strength: extras.strength ?? 'heuristic',
    effect: extras.effect ?? 'verify',
    source: extras.source ?? 'test',
    message: extras.message ?? type,
    data: extras.data ?? {}
  };
}

function facts(overrides: Partial<RouteFacts> = {}): RouteFacts {
  return {
    verdict: 'ACT',
    disposition: 'greenfield',
    findings: [],
    mandatoryFailures: [],
    linked: linked(),
    coverage: coverage(),
    ...overrides
  };
}

describe('routeContribution decision table', () => {
  it('routes ACT / greenfield to BUILD', () => {
    const input = facts();
    const decision = routeContribution(input);
    expect(decision.primary_mode).toBe('BUILD');
    expect(decision.build_contention).toBe('GREEN');
    expect(decision.confidence).toBe('high');
    expect(decision.hard_constraints).not.toContain('suppress_build');
    expect(input.verdict).toBe('ACT');
    expect(RoutingDecisionSchema.parse(decision).routing_version).toBe(1);
  });

  it('routes VERIFY / needs_repro to REPRODUCE', () => {
    const decision = routeContribution(facts({
      verdict: 'VERIFY',
      disposition: 'review',
      findings: [finding('needs_repro')],
      quality: { looksLikeBug: true, repro: 'missing', softAsk: false }
    }));
    expect(decision.primary_mode).toBe('REPRODUCE');
    expect(decision.next_actions[0]?.kind).toBe('reproduce');
    expect(decision.evidenceability.score).toBe(0.3);
  });

  it('routes SKIP / land_only to REVIEW, not PASS', () => {
    const decision = routeContribution(facts({
      verdict: 'SKIP',
      disposition: 'land_only',
      findings: [finding('linked_pr_open', { strength: 'definitive', effect: 'block' })],
      linked: linked({ activeClosers: 1 })
    }));
    expect(decision.primary_mode).toBe('REVIEW');
    expect(decision.primary_mode).not.toBe('PASS');
    expect(decision.build_contention).toBe('RED');
    expect(decision.hard_constraints).toEqual(expect.arrayContaining(['suppress_build', 'active_closer']));
    expect(decision.reasons.join(' ')).toMatch(/land_only|closer/i);
  });

  it('routes VERIFY / claim_first to WATCH', () => {
    const decision = routeContribution(facts({
      verdict: 'VERIFY',
      disposition: 'claim_first',
      findings: [finding('claim_required', { strength: 'definitive' })],
      linked: linked({ claimRequired: true })
    }));
    expect(decision.primary_mode).toBe('WATCH');
    expect(decision.next_actions[0]?.kind).toBe('coordinate');
    expect(decision.next_actions[0]?.message).toMatch(/claim protocol|assignment/i);
    expect(decision.build_contention).toBe('YELLOW');
  });

  it('routes SKIP / blocked to PASS', () => {
    const decision = routeContribution(facts({
      verdict: 'SKIP',
      disposition: 'blocked',
      findings: [finding('released_fix', { strength: 'definitive', effect: 'block' })]
    }));
    expect(decision.primary_mode).toBe('PASS');
    expect(decision.hard_constraints).toContain('released_fix');
  });

  it('routes multiple active closers to REVIEW', () => {
    const decision = routeContribution(facts({
      verdict: 'SKIP',
      disposition: 'land_only',
      findings: [
        finding('linked_pr_open', { strength: 'definitive', effect: 'block' }),
        finding('competing_open_closer', { strength: 'corroborated', effect: 'inform' })
      ],
      linked: linked({ activeClosers: 2 })
    }));
    expect(decision.primary_mode).toBe('REVIEW');
    expect(decision.build_contention).toBe('RED');
    expect(decision.hard_constraints).toContain('multiple_closers');
    expect(decision.reasons.join(' ')).toMatch(/Multiple active closers/);
  });

  it('routes a closed credible prior attempt to SALVAGE', () => {
    const decision = routeContribution(facts({
      verdict: 'VERIFY',
      disposition: 'review',
      findings: [finding('linked_pr_closed', { strength: 'definitive' })],
      linked: linked({
        closedUnmergedAttempts: 1,
        issueOpen: true,
        substantivePriorAttempt: true
      })
    }));
    expect(decision.primary_mode).toBe('SALVAGE');
    expect(decision.hard_constraints).toEqual(expect.arrayContaining([
      'coordinate_before_upstream_action',
      'preserve_attribution',
      'verify_current_main'
    ]));
    expect(decision.next_actions.map((item) => item.message).join(' ')).toMatch(/attribution|current main|Coordinate/i);
  });

  it('routes an ambiguous closed prior attempt to REVIEW, not SALVAGE', () => {
    const decision = routeContribution(facts({
      verdict: 'VERIFY',
      disposition: 'review',
      findings: [finding('linked_pr_closed', { strength: 'definitive' })],
      linked: linked({ closedUnmergedAttempts: 1, issueOpen: true })
    }));
    expect(decision.primary_mode).toBe('REVIEW');
    expect(decision.primary_mode).not.toBe('SALVAGE');
    expect(decision.reasons.join(' ')).toMatch(/not strong enough for SALVAGE|Age or inactivity/);
  });

  it('routes provider failure to low-confidence non-BUILD', () => {
    const decision = routeContribution(facts({
      verdict: 'VERIFY',
      disposition: 'review',
      mandatoryFailures: ['linked_work'],
      coverage: coverage({
        mandatory_checks_complete: false,
        failed_checks: ['linked_work'],
        rate_limit_degraded: true
      })
    }));
    expect(decision.primary_mode).not.toBe('BUILD');
    expect(decision.confidence).toBe('low');
    expect(decision.next_actions[0]?.message).toMatch(/Reevaluate/);
  });
});

describe('routeContribution safety mutations', () => {
  it('never recommends BUILD when an active definitive closer exists', () => {
    const decision = routeContribution(facts({
      verdict: 'ACT',
      disposition: 'greenfield',
      findings: [finding('linked_pr_open', { strength: 'definitive', effect: 'block' })],
      linked: linked({ activeClosers: 1 })
    }));
    expect(decision.primary_mode).not.toBe('BUILD');
    expect(decision.build_contention).toBe('RED');
    expect(decision.hard_constraints).toContain('suppress_build');
    expect(decision.alternate_modes.every((item) => item.mode !== 'BUILD' || item.score === 0)).toBe(true);
  });

  it('never emits high-confidence BUILD after a mandatory provider failure', () => {
    const decision = routeContribution(facts({
      verdict: 'ACT',
      disposition: 'greenfield',
      mandatoryFailures: ['issue_vs_main'],
      coverage: coverage({ mandatory_checks_complete: false, failed_checks: ['issue_vs_main'] })
    }));
    expect(decision.primary_mode).not.toBe('BUILD');
    expect(decision.confidence).toBe('low');
    expect(decision.confidence === 'high' && decision.primary_mode === 'BUILD').toBe(false);
  });

  it('never routes a released fix to BUILD', () => {
    const decision = routeContribution(facts({
      verdict: 'SKIP',
      disposition: 'blocked',
      findings: [finding('released_fix', { strength: 'definitive', effect: 'block' })]
    }));
    expect(decision.primary_mode).toBe('PASS');
    expect(decision.primary_mode).not.toBe('BUILD');
    expect(decision.hard_constraints).toContain('released_fix');
  });

  it('does not treat heuristic title overlap as definitive RED', () => {
    const decision = routeContribution(facts({
      verdict: 'VERIFY',
      disposition: 'review',
      findings: [finding('title_overlap_pr', { strength: 'heuristic' })],
      linked: linked({ activeRelatedPrs: 1 })
    }));
    expect(decision.build_contention).not.toBe('RED');
    expect(decision.build_contention).toBe('YELLOW');
    expect(decision.primary_mode).not.toBe('BUILD');
  });

  it('does not classify age-only stale PRs as SALVAGE', () => {
    const decision = routeContribution(facts({
      verdict: 'VERIFY',
      disposition: 'review',
      linked: linked({ staleOpenPr: true, activeRelatedPrs: 1 })
    }));
    expect(decision.primary_mode).not.toBe('SALVAGE');
    expect(decision.confidence).not.toBe('high');
    expect(decision.reasons.join(' ')).toMatch(/Age or inactivity alone is not abandonment/);
  });

  it('does not mutate the input verdict', () => {
    const input = facts({
      verdict: 'SKIP',
      disposition: 'land_only',
      linked: linked({ activeClosers: 1 }),
      findings: [finding('linked_pr_open', { strength: 'definitive', effect: 'block' })]
    });
    const before = input.verdict;
    const decision = routeContribution(input);
    expect(input.verdict).toBe(before);
    expect(decision.primary_mode).toBe('REVIEW');
    expect(input.verdict).toBe('SKIP');
  });

  it('does not promote ACT-like weak proof to BUILD', () => {
    const decision = routeContribution(facts({
      verdict: 'ACT',
      disposition: 'greenfield',
      quality: { looksLikeBug: true, repro: 'weak', softAsk: false }
    }));
    expect(decision.primary_mode).toBe('REPRODUCE');
    expect(decision.primary_mode).not.toBe('BUILD');
  });
});

describe('routeContribution additional modes', () => {
  it('routes no_pr_path to PASS', () => {
    const decision = routeContribution(facts({
      verdict: 'VERIFY',
      disposition: 'blocked',
      findings: [finding('no_pr_path', { strength: 'definitive' })]
    }));
    expect(decision.primary_mode).toBe('PASS');
    expect(decision.hard_constraints).toContain('no_pr_path');
    expect(decision.primary_mode).not.toBe('BUILD');
  });

  it('routes assigned issues to WATCH', () => {
    const decision = routeContribution(facts({
      verdict: 'VERIFY',
      disposition: 'claim_first',
      findings: [finding('assigned', { strength: 'definitive' })],
      linked: linked({ assigned: true })
    }));
    expect(decision.primary_mode).toBe('WATCH');
    expect(decision.next_actions[0]?.message).toMatch(/Reevaluate/);
  });

  it('routes a healthy single closer to WATCH', () => {
    const decision = routeContribution(facts({
      verdict: 'SKIP',
      disposition: 'land_only',
      linked: linked({ activeClosers: 1, healthyActiveCloser: true }),
      findings: [finding('linked_pr_open', { strength: 'definitive', effect: 'block' })]
    }));
    expect(decision.primary_mode).toBe('WATCH');
    expect(decision.build_contention).toBe('RED');
    expect(decision.next_actions[0]?.message).toMatch(/Reevaluate/);
  });

  it('routes source-driven eval tasks to EVAL when otherwise BUILD-eligible', () => {
    const decision = routeContribution(facts({
      categoryHints: { documentation: false, evaluation: true }
    }));
    expect(decision.primary_mode).toBe('EVAL');
    expect(decision.effort_bucket).toBe('research');
  });

  it('routes clearly documentation-only actionable work to DOC', () => {
    const decision = routeContribution(facts({
      categoryHints: { documentation: true, evaluation: false }
    }));
    expect(decision.primary_mode).toBe('DOC');
    expect(decision.effort_bucket).toBe('fast');
  });

  it('does not route ordinary issues to DOC or EVAL', () => {
    const decision = routeContribution(facts({
      categoryHints: { documentation: false, evaluation: false }
    }));
    expect(decision.primary_mode).toBe('BUILD');
  });

  it('routes fully resolved implementation to PASS', () => {
    const decision = routeContribution(facts({
      verdict: 'SKIP',
      disposition: 'blocked',
      linked: linked({ fullyResolved: true, mergedClosers: 1 })
    }));
    expect(decision.primary_mode).toBe('PASS');
  });

  it('scores evidenceability from reused quality hints', () => {
    expect(routeContribution(facts({
      quality: { looksLikeBug: true, repro: 'present', softAsk: false }
    })).evidenceability).toEqual({ score: 0.9, reasons: ['repro present'] });
    expect(routeContribution(facts({
      quality: { looksLikeBug: true, repro: 'weak', softAsk: false }
    })).evidenceability.score).toBe(0.6);
    expect(routeContribution(facts()).evidenceability.score).toBe(0.5);
  });

  it('lowers confidence for stale snapshots and advisory gaps without creating a hard verdict', () => {
    const stale = routeContribution(facts({
      coverage: coverage({ snapshot_age_ms: 5 * 24 * 60 * 60 * 1000 })
    }));
    expect(stale.confidence).toBe('low');
    expect(stale.primary_mode).not.toBe('PASS');

    const advisory = routeContribution(facts({
      coverage: coverage({ advisory_missing: ['semantic_index'] })
    }));
    expect(advisory.confidence).toBe('medium');
    expect(advisory.primary_mode).not.toBe('PASS');
    expect(advisory.build_contention).toBe('YELLOW');
  });

  it('always states a WATCH reevaluation trigger', () => {
    const decision = routeContribution(facts({
      verdict: 'VERIFY',
      disposition: 'claim_first',
      linked: linked({ assigned: true })
    }));
    expect(decision.primary_mode).toBe('WATCH');
    expect(decision.next_actions.some((item) => /Reevaluate/i.test(item.message))).toBe(true);
  });
});
