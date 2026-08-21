import type { RouteFacts, ContributionMode } from '../contracts/routing.js';
import { routeContribution } from '../decision/contribution-route.js';
import {
  RoutingEvalMetricsSchema,
  type RoutingEvalCase,
  type RoutingEvalMetrics
} from '../contracts/routing-eval.js';
import { reconstructedRoutingCases } from './routing-eval-cases.js';

function asFacts(value: Record<string, unknown>): RouteFacts {
  return value as unknown as RouteFacts;
}

export function scoreRoutingCases(cases: RoutingEvalCase[]): RoutingEvalMetrics {
  let top1 = 0;
  let acceptable = 0;
  let falseBuildOccupied = 0;
  let falseBuildBlocked = 0;
  let falsePassActionable = 0;
  const counts_by_mode: Record<string, number> = {};
  const counts_by_contention: Record<string, number> = {};
  const counts_by_confidence: Record<string, number> = {};
  const snapshot = cases.filter((item) => item.partition === 'snapshot');
  const reconstructed = cases.filter((item) => item.partition === 'reconstructed');
  const headline = snapshot.length > 0 ? snapshot : [];

  for (const item of cases) {
    const decision = routeContribution(asFacts(item.facts));
    counts_by_mode[decision.primary_mode] = (counts_by_mode[decision.primary_mode] ?? 0) + 1;
    counts_by_contention[decision.build_contention] = (counts_by_contention[decision.build_contention] ?? 0) + 1;
    counts_by_confidence[decision.confidence] = (counts_by_confidence[decision.confidence] ?? 0) + 1;
    const okTop = decision.primary_mode === item.expected.primary_mode;
    const okAccept = okTop || item.expected.acceptable_modes.includes(decision.primary_mode);
    if (item.partition === 'snapshot') {
      if (okTop) top1 += 1;
      if (okAccept) acceptable += 1;
    }
    if (item.expected.forbidden_modes.includes('BUILD') && decision.primary_mode === 'BUILD') {
      falseBuildOccupied += 1;
    }
    if (item.expected.primary_mode === 'BUILD' && decision.primary_mode !== 'BUILD' && !item.expected.acceptable_modes.includes(decision.primary_mode)) {
      falseBuildBlocked += 1;
    }
    if (item.expected.forbidden_modes.includes('PASS') && decision.primary_mode === 'PASS') {
      falsePassActionable += 1;
    }
  }

  const headlineCount = headline.length;
  return RoutingEvalMetricsSchema.parse({
    routing_cases: cases.length,
    snapshot_cases: snapshot.length,
    reconstructed_cases: reconstructed.length,
    mode_top1_accuracy: headlineCount === 0 ? null : top1 / headlineCount,
    acceptable_mode_accuracy: headlineCount === 0 ? null : acceptable / headlineCount,
    false_build_occupied: falseBuildOccupied,
    false_build_blocked: falseBuildBlocked,
    false_pass_actionable: falsePassActionable,
    counts_by_mode,
    counts_by_contention,
    counts_by_confidence,
    headline_excludes_reconstructed: true
  });
}

export function runReconstructedRoutingEval(): RoutingEvalMetrics {
  return scoreRoutingCases(reconstructedRoutingCases);
}

export function coverageHasMode(mode: ContributionMode): boolean {
  return reconstructedRoutingCases.some((item) => item.expected.primary_mode === mode);
}
