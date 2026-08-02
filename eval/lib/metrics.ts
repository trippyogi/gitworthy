import type {
  EvalCase,
  EvalMilestone,
  EvalQualityMetrics,
  EvalReleaseGate,
  EvalReleaseGateStatus,
  EvalSuiteReport,
  EvalSuiteReportRow
} from '../../src/contracts/eval.js';
import { EVAL_MILESTONE_THRESHOLDS } from '../../src/contracts/eval.js';
import type { VerdictSchema } from '../../src/contracts/common.js';
import type { z } from 'zod';

type Verdict = z.infer<typeof VerdictSchema>;

export type FrozenCaseEntry = {
  caseFile: string;
  spec: EvalCase;
};

export type CaseAdjudication = {
  case: EvalCase;
  row?: EvalSuiteReportRow;
  expected_verdict?: Verdict;
  observed_verdict?: Verdict;
  hard_skip: boolean;
  false_hard_skip: boolean;
  false_act: boolean;
  verify_reason?: string;
  mechanism_only: boolean;
  repo?: string;
  duration_ms?: number;
  github_requests?: number;
  schema_valid?: boolean;
};

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function increment(map: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null;
}

function precision(truePositive: number, falsePositive: number): number | null {
  const denominator = truePositive + falsePositive;
  if (denominator === 0) return null;
  return truePositive / denominator;
}

function repoFromInput(input: Record<string, unknown>): string | undefined {
  return typeof input.repo === 'string' ? input.repo : undefined;
}

function parseObservedVerdict(row: EvalSuiteReportRow | undefined): Verdict | undefined {
  if (row?.observed_verdict) return row.observed_verdict;
  if (!row?.detail) return undefined;
  const match = row.detail.match(/observed (ACT|VERIFY|SKIP)/);
  return match ? match[1] as Verdict : undefined;
}

function isHardSkip(row: EvalSuiteReportRow | undefined, observed: Verdict | undefined): boolean {
  if (row?.hard_skip !== undefined) return row.hard_skip;
  return observed === 'SKIP';
}

function verifyReason(caseSpec: EvalCase, row: EvalSuiteReportRow | undefined, expected?: Verdict, observed?: Verdict): string | undefined {
  if (row?.verify_reason) return row.verify_reason;
  if (expected === 'VERIFY' || observed === 'VERIFY') return caseSpec.ground_truth?.failure_mode;
  return undefined;
}

export function buildCaseAdjudications(cases: FrozenCaseEntry[], report: EvalSuiteReport): CaseAdjudication[] {
  const rowById = new Map(report.rows.map((row) => [row.id, row]));
  return cases.map(({ spec }) => {
    const row = rowById.get(spec.id);
    const expected = spec.ground_truth?.verdict ?? row?.expected_verdict;
    const observed = row?.observed_verdict ?? parseObservedVerdict(row);
    const mechanism_only = expected !== undefined && observed === undefined;
    const hard_skip = isHardSkip(row, observed);
    const false_hard_skip = observed === 'SKIP' && expected !== undefined && expected !== 'SKIP';
    const false_act = expected === 'ACT' && observed !== undefined && observed !== 'ACT';
    return {
      case: spec,
      row,
      expected_verdict: expected,
      observed_verdict: observed,
      hard_skip,
      false_hard_skip,
      false_act,
      verify_reason: verifyReason(spec, row, expected, observed),
      mechanism_only,
      repo: row?.repo ?? repoFromInput(spec.input),
      duration_ms: row?.duration_ms,
      github_requests: row?.github_requests,
      schema_valid: row?.schema_valid
    };
  });
}

export function computeQualityMetrics(
  adjudications: CaseAdjudication[],
  milestone: EvalMilestone
): EvalQualityMetrics {
  const thresholds = EVAL_MILESTONE_THRESHOLDS[milestone];
  const verdictCases = adjudications.filter((item) => !item.mechanism_only && item.expected_verdict !== undefined);
  const mechanismOnly = adjudications.filter((item) => item.mechanism_only);
  const ids = adjudications.map((item) => item.case.id);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);

  const counts_by_verdict = emptyCounts(['ACT', 'VERIFY', 'SKIP'] as const);
  const counts_by_disposition = emptyCounts(['greenfield', 'land_only', 'claim_first', 'blocked', 'crowded', 'review'] as const);
  const counts_by_failure_mode: Record<string, number> = {};
  const counts_by_repository: Record<string, number> = {};
  const counts_by_row_status = emptyCounts([
    'passed', 'failed', 'drifted', 'blocked', 'provider_failure', 'auth_limitation', 'product_regression'
  ] as const);
  const verify_by_reason: Record<string, number> = {};

  let hardSkipTp = 0;
  let hardSkipFp = 0;
  let hardSkipFn = 0;
  let actTp = 0;
  let actFp = 0;
  let actFn = 0;
  let falseHardSkipCount = 0;
  let falseActCount = 0;
  let schemaFailureCount = 0;

  const durations: number[] = [];
  const requests: number[] = [];
  const coveredFailureModes = new Set<string>();
  const coveredHardSkipPaths = new Set<string>();
  const coveredErrorClasses = new Set<string>();

  for (const item of adjudications) {
    const truth = item.case.ground_truth;
    if (truth) increment(counts_by_failure_mode, truth.failure_mode);
    if (truth) coveredFailureModes.add(truth.failure_mode);
    increment(counts_by_repository, item.repo);
    if (item.row) increment(counts_by_row_status, item.row.status);
    if (item.schema_valid === false) schemaFailureCount += 1;

    // counts_by_verdict = expected (adjudicated) distribution only — not blended with observed.
    if (item.expected_verdict) increment(counts_by_verdict, item.expected_verdict);
    if (truth?.disposition) increment(counts_by_disposition, truth.disposition);

    if (item.verify_reason) {
      verify_by_reason[item.verify_reason] = (verify_by_reason[item.verify_reason] ?? 0) + 1;
    }

    if (typeof item.duration_ms === 'number') durations.push(item.duration_ms);
    if (typeof item.github_requests === 'number') requests.push(item.github_requests);

    if (item.mechanism_only || item.expected_verdict === undefined || item.observed_verdict === undefined) continue;

    if (item.observed_verdict === 'SKIP') {
      if (item.expected_verdict === 'SKIP') {
        hardSkipTp += 1;
        if (item.hard_skip) {
          coveredHardSkipPaths.add(truth?.failure_mode ?? 'skip');
          for (const signal of truth?.required_signals ?? []) coveredHardSkipPaths.add(signal);
        }
      } else {
        hardSkipFp += 1;
      }
    } else if (item.expected_verdict === 'SKIP') {
      hardSkipFn += 1;
    }

    if (item.expected_verdict === 'ACT') {
      if (item.observed_verdict === 'ACT') actTp += 1;
      else actFn += 1;
    }
    if (item.observed_verdict === 'ACT' && item.expected_verdict !== 'ACT') actFp += 1;

    if (item.false_hard_skip) {
      falseHardSkipCount += 1;
      coveredErrorClasses.add('false_hard_skip');
    }
    if (item.false_act) falseActCount += 1;

    if (item.row?.status === 'provider_failure') coveredErrorClasses.add('provider_failure');
    if (item.row?.status === 'auth_limitation') coveredErrorClasses.add('auth_limitation');
  }

  durations.sort((a, b) => a - b);
  requests.sort((a, b) => a - b);

  const incompleteIds = adjudications
    .filter((item) => !item.case.ground_truth || !item.case.provider_fixtures)
    .map((item) => item.case.id);
  const staleIds = adjudications
    .filter((item) => item.case.time_sensitive === true)
    .map((item) => item.case.id);
  const unadjudicated = adjudications.filter((item) => !item.case.ground_truth).length;

  const failureModeGaps = thresholds.required_failure_modes.filter((mode) => !coveredFailureModes.has(mode));
  const hardSkipGaps = thresholds.required_hard_skip_paths.filter((path) => !coveredHardSkipPaths.has(path));
  const errorClassGaps = thresholds.required_error_classes.filter((cls) => !coveredErrorClasses.has(cls));

  return {
    adjudicated_cases: adjudications.filter((item) => item.case.ground_truth).length,
    verdict_cases: verdictCases.length,
    mechanism_only_cases: mechanismOnly.length,
    unadjudicated_cases: unadjudicated,
    duplicate_case_ids: [...new Set(duplicateIds)],
    stale_case_ids: staleIds,
    incomplete_case_ids: incompleteIds,
    hard_skip: {
      true_positive: hardSkipTp,
      false_positive: hardSkipFp,
      false_negative: hardSkipFn,
      precision: precision(hardSkipTp, hardSkipFp),
      denominator: hardSkipTp + hardSkipFp
    },
    act: {
      true_positive: actTp,
      false_positive: actFp,
      false_negative: actFn,
      precision: precision(actTp, actFn),
      denominator: actTp + actFn
    },
    false_hard_skip_count: falseHardSkipCount,
    false_act_count: falseActCount,
    verify_by_reason,
    schema_failure_count: schemaFailureCount,
    counts_by_verdict,
    counts_by_disposition,
    counts_by_failure_mode,
    counts_by_repository,
    counts_by_row_status,
    duration_ms: {
      available: durations.length,
      median: percentile(durations, 50),
      p95: percentile(durations, 95)
    },
    github_requests: {
      available: requests.length,
      median: percentile(requests, 50),
      p95: percentile(requests, 95)
    },
    coverage_gaps: {
      failure_modes: failureModeGaps,
      hard_skip_paths: hardSkipGaps,
      error_classes: errorClassGaps
    }
  };
}

export function evaluateReleaseGates(
  metrics: EvalQualityMetrics,
  adjudications: CaseAdjudication[],
  milestone: EvalMilestone
): { gates: EvalReleaseGate[]; release_status: EvalReleaseGateStatus } {
  const thresholds = EVAL_MILESTONE_THRESHOLDS[milestone];
  const gates: EvalReleaseGate[] = [];
  const falseHardSkipIds = adjudications.filter((item) => item.false_hard_skip).map((item) => item.case.id);

  gates.push({
    id: 'false_hard_skip',
    status: metrics.false_hard_skip_count <= thresholds.max_false_hard_skip ? 'pass' : 'fail',
    message: metrics.false_hard_skip_count === 0
      ? 'No false hard SKIP on adjudicated verdict cases.'
      : `${metrics.false_hard_skip_count} false hard SKIP case(s) on adjudicated verdict cases.`,
    threshold: `max ${thresholds.max_false_hard_skip}`,
    observed: String(metrics.false_hard_skip_count),
    case_ids: falseHardSkipIds
  });

  const caseCountStatus: EvalReleaseGateStatus = metrics.adjudicated_cases >= thresholds.min_adjudicated_cases
    ? 'pass'
    : 'warn';
  gates.push({
    id: 'adjudicated_case_count',
    status: caseCountStatus,
    message: caseCountStatus === 'pass'
      ? `Adjudicated frozen corpus meets ${milestone} minimum (${metrics.adjudicated_cases} cases).`
      : `Adjudicated frozen corpus has ${metrics.adjudicated_cases} cases; ${milestone} target is ${thresholds.min_adjudicated_cases}.`,
    threshold: `>= ${thresholds.min_adjudicated_cases}`,
    observed: String(metrics.adjudicated_cases)
  });

  const repoCount = Object.keys(metrics.counts_by_repository).length;
  if (thresholds.min_repositories > 0) {
    gates.push({
      id: 'repository_coverage',
      status: repoCount >= thresholds.min_repositories ? 'pass' : 'warn',
      message: repoCount >= thresholds.min_repositories
        ? `Repository coverage meets ${milestone} minimum (${repoCount} repositories).`
        : `Only ${repoCount} repositories in corpus; ${milestone} target is ${thresholds.min_repositories}.`,
      threshold: `>= ${thresholds.min_repositories}`,
      observed: String(repoCount)
    });
  }

  if (thresholds.min_act_precision !== null) {
    const actPrecision = metrics.act.precision;
    gates.push({
      id: 'act_precision',
      status: actPrecision !== null && actPrecision >= thresholds.min_act_precision ? 'pass' : 'fail',
      message: actPrecision === null
        ? 'No adjudicated ACT verdict cases to score ACT precision.'
        : `ACT precision ${(actPrecision * 100).toFixed(1)}% on adjudicated investigated ACT cases.`,
      threshold: `>= ${(thresholds.min_act_precision * 100).toFixed(0)}%`,
      observed: actPrecision === null ? 'n/a' : `${(actPrecision * 100).toFixed(1)}%`
    });
  }

  for (const gap of [
    { id: 'failure_mode_coverage', items: metrics.coverage_gaps.failure_modes },
    { id: 'hard_skip_path_coverage', items: metrics.coverage_gaps.hard_skip_paths },
    { id: 'error_class_coverage', items: metrics.coverage_gaps.error_classes }
  ]) {
    if (gap.items.length === 0) continue;
    gates.push({
      id: gap.id,
      status: milestone === '0.6.0' ? 'warn' : 'fail',
      message: `Missing coverage: ${gap.items.join(', ')}`,
      observed: gap.items.join(', ')
    });
  }

  if (metrics.duplicate_case_ids.length > 0) {
    gates.push({
      id: 'duplicate_cases',
      status: 'fail',
      message: `Duplicate case IDs: ${metrics.duplicate_case_ids.join(', ')}`,
      case_ids: metrics.duplicate_case_ids
    });
  }

  if (metrics.incomplete_case_ids.length > 0) {
    gates.push({
      id: 'incomplete_cases',
      status: 'fail',
      message: `Incomplete frozen cases: ${metrics.incomplete_case_ids.join(', ')}`,
      case_ids: metrics.incomplete_case_ids
    });
  }

  const release_status: EvalReleaseGateStatus = gates.some((gate) => gate.status === 'fail')
    ? 'fail'
    : gates.some((gate) => gate.status === 'warn')
      ? 'warn'
      : 'pass';

  return { gates, release_status };
}

export function formatQualitySummary(
  milestone: EvalMilestone,
  metrics: EvalQualityMetrics,
  gates: EvalReleaseGate[],
  release_status: EvalReleaseGateStatus
): string {
  const lines = [
    `Gitworthy eval quality report (${milestone}) — release ${release_status.toUpperCase()}`,
    `Adjudicated cases: ${metrics.adjudicated_cases} (verdict-scored: ${metrics.verdict_cases}, mechanism-only: ${metrics.mechanism_only_cases})`,
    `Hard-SKIP precision: ${metrics.hard_skip.precision === null ? 'n/a' : `${(metrics.hard_skip.precision * 100).toFixed(1)}%`} `
      + `(TP=${metrics.hard_skip.true_positive}, FP=${metrics.hard_skip.false_positive}, false hard SKIP=${metrics.false_hard_skip_count})`,
    `ACT precision (adjudicated ACT cases): ${metrics.act.precision === null ? 'n/a' : `${(metrics.act.precision * 100).toFixed(1)}%`} `
      + `(denominator=${metrics.act.denominator}, false ACT=${metrics.false_act_count})`,
    `VERIFY by reason: ${Object.keys(metrics.verify_by_reason).length === 0 ? 'none' : Object.entries(metrics.verify_by_reason).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `Duration ms (n=${metrics.duration_ms.available}): median=${metrics.duration_ms.median ?? 'n/a'}, p95=${metrics.duration_ms.p95 ?? 'n/a'}`,
    `GitHub requests (n=${metrics.github_requests.available}): median=${metrics.github_requests.median ?? 'n/a'}, p95=${metrics.github_requests.p95 ?? 'n/a'}`,
    'Gates:'
  ];
  for (const gate of gates) {
    lines.push(`  [${gate.status.toUpperCase()}] ${gate.id}: ${gate.message}`);
  }
  return lines.join('\n');
}
