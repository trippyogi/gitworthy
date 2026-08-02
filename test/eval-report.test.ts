import { describe, expect, it } from 'vitest';
import {
  EvalQualityReportSchema,
  EvalSuiteReportSchema,
  type EvalCase,
  type EvalSuiteReport
} from '../src/contracts/eval.js';
import {
  buildCaseAdjudications,
  computeQualityMetrics,
  evaluateReleaseGates
} from '../eval/lib/metrics.js';
import { exitCodeForQualityReport, generateEvalQualityReport } from '../eval/lib/report-gen.js';

function frozenCase(id: string, truth: Partial<EvalCase['ground_truth']> & { failure_mode: string; verdict: 'ACT' | 'VERIFY' | 'SKIP' }): EvalCase {
  return {
    case_version: 1,
    id,
    suite: 'frozen',
    name: id,
    function: 'worth_check',
    input: { repo: `owner/${id}`, issue_number: 1 },
    classification: 'frozen',
    ground_truth: {
      disposition: truth.verdict === 'SKIP' ? 'blocked' : truth.verdict === 'ACT' ? 'greenfield' : 'crowded',
      adjudicator_rationale: 'fixture',
      evidence_urls: ['https://example.test/1'],
      required_findings: [],
      forbidden_findings: [],
      required_signals: [],
      forbidden_signals: [],
      ...truth
    },
    provider_fixtures: '../fixtures/x.json',
    time_sensitive: false
  };
}

function suiteRow(
  spec: EvalCase,
  observed: 'ACT' | 'VERIFY' | 'SKIP',
  status: 'passed' | 'failed' = 'passed'
): EvalSuiteReport['rows'][number] {
  return {
    id: spec.id,
    name: spec.name,
    status,
    detail: status === 'passed' ? 'ok' : `expected verdict ${spec.ground_truth!.verdict}, observed ${observed}`,
    failure_mode: spec.ground_truth!.failure_mode,
    function: spec.function,
    repo: String(spec.input.repo),
    expected_verdict: spec.ground_truth!.verdict,
    observed_verdict: observed,
    hard_skip: observed === 'SKIP',
    verify_reason: spec.ground_truth!.verdict === 'VERIFY' ? spec.ground_truth!.failure_mode : undefined,
    duration_ms: 100,
    github_requests: 5,
    schema_valid: true
  };
}

function suiteReport(rows: EvalSuiteReport['rows']): EvalSuiteReport {
  return EvalSuiteReportSchema.parse({
    suite: 'frozen',
    release_blocking: true,
    generated_at: '2026-08-02T00:00:00.000Z',
    gitworthy_version: '0.4.1',
    summary: {
      total: rows.length,
      passed: rows.filter((row) => row.status === 'passed').length,
      failed: rows.filter((row) => row.status === 'failed').length,
      drifted: 0,
      blocked: 0,
      provider_failure: 0,
      auth_limitation: 0,
      product_regression: 0
    },
    rows,
    notes: []
  });
}

describe('eval quality metrics (GW-023)', () => {
  it('computes confusion-matrix metrics from adjudicated verdict cases', () => {
    const cases = [
      frozenCase('skip-ok', { verdict: 'SKIP', failure_mode: 'released_fix' }),
      frozenCase('skip-false', { verdict: 'ACT', failure_mode: 'greenfield_open' }),
      frozenCase('act-ok', { verdict: 'ACT', failure_mode: 'greenfield_open' }),
      frozenCase('act-miss', { verdict: 'ACT', failure_mode: 'greenfield_open' }),
      frozenCase('verify-reason', { verdict: 'VERIFY', failure_mode: 'lexical_duplicate_signal_present' })
    ];
    const report = suiteReport([
      suiteRow(cases[0]!, 'SKIP'),
      suiteRow(cases[1]!, 'SKIP', 'failed'),
      suiteRow(cases[2]!, 'ACT'),
      suiteRow(cases[3]!, 'VERIFY', 'failed'),
      suiteRow(cases[4]!, 'VERIFY')
    ]);

    const adjudications = buildCaseAdjudications(cases.map((spec) => ({ caseFile: `${spec.id}.json`, spec })), report);
    const metrics = computeQualityMetrics(adjudications, '0.6.0');

    expect(metrics.hard_skip.true_positive).toBe(1);
    expect(metrics.hard_skip.false_positive).toBe(1);
    expect(metrics.hard_skip.precision).toBe(0.5);
    expect(metrics.false_hard_skip_count).toBe(1);
    expect(metrics.act.true_positive).toBe(1);
    expect(metrics.act.false_negative).toBe(2);
    expect(metrics.act.precision).toBeCloseTo(1 / 3);
    expect(metrics.verify_by_reason).toEqual({
      greenfield_open: 1,
      lexical_duplicate_signal_present: 1
    });
    expect(metrics.duration_ms.median).toBe(100);
    expect(metrics.github_requests.p95).toBe(5);
  });

  it('fails release gate on a single false hard SKIP', () => {
    const spec = frozenCase('bad-skip', { verdict: 'ACT', failure_mode: 'should_act' });
    const report = suiteReport([suiteRow(spec, 'SKIP', 'failed')]);
    const adjudications = buildCaseAdjudications([{ caseFile: 'bad-skip.json', spec }], report);
    const metrics = computeQualityMetrics(adjudications, '0.6.0');
    const { gates, release_status } = evaluateReleaseGates(metrics, adjudications, '0.6.0');

    expect(release_status).toBe('fail');
    expect(gates.find((gate) => gate.id === 'false_hard_skip')?.status).toBe('fail');
    expect(gates.find((gate) => gate.id === 'false_hard_skip')?.case_ids).toEqual(['bad-skip']);
  });

  it('warns on case-count for 0.6.0 without failing when no false hard SKIP', () => {
    const spec = frozenCase('only-one', { verdict: 'VERIFY', failure_mode: 'lexical_duplicate_signal_present' });
    const report = suiteReport([suiteRow(spec, 'VERIFY')]);
    const adjudications = buildCaseAdjudications([{ caseFile: 'only-one.json', spec }], report);
    const metrics = computeQualityMetrics(adjudications, '0.6.0');
    const { release_status } = evaluateReleaseGates(metrics, adjudications, '0.6.0');

    expect(release_status).toBe('warn');
  });

  it('handles empty corpus without throwing', () => {
    const metrics = computeQualityMetrics([], '0.6.0');
    expect(metrics.adjudicated_cases).toBe(0);
    expect(metrics.hard_skip.precision).toBeNull();
    expect(metrics.act.precision).toBeNull();
  });

  it('serializes deterministic quality reports', () => {
    const spec = frozenCase('verify-one', { verdict: 'VERIFY', failure_mode: 'lexical_duplicate_signal_present' });
    const report = generateEvalQualityReport({
      cases: [{ caseFile: 'verify-one.json', spec }],
      suiteReport: suiteReport([suiteRow(spec, 'VERIFY')]),
      milestone: '0.6.0',
      suiteReportPath: 'eval/reports/frozen-latest.json',
      caseCatalogPath: 'eval/frozen/cases',
      generatedAt: '2026-08-02T12:00:00.000Z'
    });

    const again = generateEvalQualityReport({
      cases: [{ caseFile: 'verify-one.json', spec }],
      suiteReport: suiteReport([suiteRow(spec, 'VERIFY')]),
      milestone: '0.6.0',
      suiteReportPath: 'eval/reports/frozen-latest.json',
      caseCatalogPath: 'eval/frozen/cases',
      generatedAt: '2026-08-02T12:00:00.000Z'
    });

    expect(JSON.stringify(EvalQualityReportSchema.parse(report))).toBe(JSON.stringify(EvalQualityReportSchema.parse(again)));
    expect(exitCodeForQualityReport(report)).toBe(0);
  });

  it('computes duration/request percentiles at boundaries', () => {
    const cases = [1, 2, 3, 4, 5].map((n) => frozenCase(`case-${n}`, { verdict: 'VERIFY', failure_mode: `mode-${n}` }));
    const report = suiteReport(cases.map((spec, index) => ({
      ...suiteRow(spec, 'VERIFY'),
      duration_ms: (index + 1) * 10,
      github_requests: index + 1
    })));
    const metrics = computeQualityMetrics(
      buildCaseAdjudications(cases.map((spec) => ({ caseFile: `${spec.id}.json`, spec })), report),
      '0.6.0'
    );
    expect(metrics.duration_ms.median).toBe(30);
    expect(metrics.duration_ms.p95).toBe(50);
    expect(metrics.github_requests.median).toBe(3);
    expect(metrics.github_requests.p95).toBe(5);
  });

  it('traces aggregate failures back to case IDs', () => {
    const bad = frozenCase('trace-me', { verdict: 'ACT', failure_mode: 'should_act' });
    const quality = generateEvalQualityReport({
      cases: [{ caseFile: 'trace-me.json', spec: bad }],
      suiteReport: suiteReport([suiteRow(bad, 'SKIP', 'failed')]),
      milestone: '0.6.0',
      suiteReportPath: 'eval/reports/frozen-latest.json',
      caseCatalogPath: 'eval/frozen/cases',
      generatedAt: '2026-08-02T12:00:00.000Z'
    });

    const traced = quality.cases.find((item) => item.id === 'trace-me');
    expect(traced?.false_hard_skip).toBe(true);
    expect(quality.gates.find((gate) => gate.id === 'false_hard_skip')?.case_ids).toContain('trace-me');
    expect(exitCodeForQualityReport(quality)).toBe(1);
  });
});
