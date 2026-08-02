import {
  EvalQualityReportSchema,
  EvalSuiteReportSchema,
  type EvalMilestone,
  type EvalQualityReport
} from '../../src/contracts/eval.js';
import { packageVersion } from '../../src/lib/package-meta.js';
import {
  buildCaseAdjudications,
  computeQualityMetrics,
  evaluateReleaseGates,
  formatQualitySummary,
  type FrozenCaseEntry
} from './metrics.js';

export type GenerateEvalReportInput = {
  cases: FrozenCaseEntry[];
  suiteReport: unknown;
  milestone: EvalMilestone;
  suiteReportPath: string;
  caseCatalogPath: string;
  generatedAt?: string;
};

export function generateEvalQualityReport(input: GenerateEvalReportInput): EvalQualityReport {
  const suiteReport = EvalSuiteReportSchema.parse(input.suiteReport);
  if (suiteReport.suite !== 'frozen') {
    throw new Error(`Expected frozen suite report, got ${suiteReport.suite}`);
  }

  const adjudications = buildCaseAdjudications(input.cases, suiteReport);
  const metrics = computeQualityMetrics(adjudications, input.milestone);
  const { gates, release_status } = evaluateReleaseGates(metrics, adjudications, input.milestone);
  const summary_text = formatQualitySummary(input.milestone, metrics, gates, release_status);

  return EvalQualityReportSchema.parse({
    report_version: 1,
    milestone: input.milestone,
    suite: 'frozen',
    generated_at: input.generatedAt ?? new Date().toISOString(),
    gitworthy_version: packageVersion(),
    source: {
      suite_report: input.suiteReportPath,
      case_catalog: input.caseCatalogPath
    },
    release_status,
    gates,
    metrics,
    cases: adjudications.map((item) => ({
      id: item.case.id,
      name: item.case.name,
      status: item.row?.status ?? 'failed',
      failure_mode: item.case.ground_truth?.failure_mode,
      expected_verdict: item.expected_verdict,
      observed_verdict: item.observed_verdict,
      hard_skip: item.hard_skip,
      false_hard_skip: item.false_hard_skip,
      false_act: item.false_act,
      verify_reason: item.verify_reason,
      detail: item.row?.detail ?? 'missing suite row'
    })),
    summary_text
  });
}

export function exitCodeForQualityReport(report: EvalQualityReport): number {
  return report.release_status === 'fail' ? 1 : 0;
}
