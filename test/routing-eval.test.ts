import { describe, expect, it } from 'vitest';
import { OutcomeEventSchema } from '../src/contracts/outcomes.js';
import { EvalGroundTruthSchema } from '../src/contracts/eval.js';
import { runReconstructedRoutingEval } from '../src/core/routing-eval.js';
import { reconstructedRoutingCases } from '../src/core/routing-eval-cases.js';
import { routeContribution } from '../src/decision/contribution-route.js';
import type { RouteFacts } from '../src/contracts/routing.js';

describe('routing eval reconstructed partition', () => {
  it('keeps reconstructed cases out of headline accuracy and forbids occupied BUILD', () => {
    const metrics = runReconstructedRoutingEval();
    expect(metrics.reconstructed_cases).toBe(reconstructedRoutingCases.length);
    expect(metrics.snapshot_cases).toBe(0);
    expect(metrics.mode_top1_accuracy).toBeNull();
    expect(metrics.headline_excludes_reconstructed).toBe(true);
    expect(metrics.false_build_occupied).toBe(0);
    for (const item of reconstructedRoutingCases) {
      const decision = routeContribution(item.facts as unknown as RouteFacts);
      expect(
        [item.expected.primary_mode, ...item.expected.acceptable_modes],
        item.id
      ).toContain(decision.primary_mode);
      expect(item.expected.forbidden_modes, item.id).not.toContain(decision.primary_mode);
    }
  });

  it('covers seed modes including adversarial ownership cases', () => {
    const ids = reconstructedRoutingCases.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      'recon-unoccupied-bug-build',
      'recon-missing-repro',
      'recon-explicit-closer',
      'recon-released-fix',
      'adv-closer-provider-error',
      'adv-title-overlap-only'
    ]));
  });

  it('still parses legacy outcomes without contribution_mode', () => {
    const parsed = OutcomeEventSchema.parse({
      event_version: 1,
      event_id: 'e1',
      decision_id: 'd1',
      run_id: 'r1',
      target: { repo: 'o/r', issue_number: 1 },
      event: 'selected',
      occurred_at: '2026-08-01T00:00:00.000Z',
      source: 'test',
      data: {},
      notes: ''
    });
    expect(parsed.contribution_mode).toBeUndefined();
  });

  it('accepts additive routing ground truth', () => {
    const parsed = EvalGroundTruthSchema.parse({
      verdict: 'SKIP',
      disposition: 'land_only',
      failure_mode: 'occupied_closer',
      adjudicator_rationale: 'explicit closer owns the issue',
      evidence_urls: ['https://example.com/issue'],
      routing: {
        primary_mode: 'REVIEW',
        acceptable_modes: ['WATCH'],
        forbidden_modes: ['BUILD'],
        build_contention: 'RED'
      }
    });
    expect(parsed.routing?.forbidden_modes).toContain('BUILD');
  });
});
