import { z } from 'zod';
import { DispositionSchema, SCHEMA_VERSION, SchemaVersionSchema, VerdictSchema } from './common.js';
import { BuildContentionSchema, ContributionModeSchema } from './routing.js';

/** Case/adjudication contract shared by frozen, live, and private eval suites (GW-021). */
export const EVAL_CASE_VERSION = 1 as const;

export const EvalSuiteSchema = z.enum(['frozen', 'live', 'private']);
export const EvalCommandSchema = z.enum([
  'branch_scan',
  'issue_vs_main',
  'release_gap',
  'dupe_cluster',
  'contrib_policy',
  'linked_work',
  'contention',
  'worth_check'
]);

export const EvalLiveExpectationSchema = z.object({
  signal: z.string().min(1).optional(),
  no_signal: z.string().min(1).optional(),
  verdict: VerdictSchema.optional(),
  summary_contains: z.string().min(1).optional(),
  evidence_contains: z.string().min(1).optional(),
  evidence_contains_all: z.array(z.string().min(1)).optional()
}).strict();

export const EvalGroundTruthSchema = z.object({
  verdict: VerdictSchema,
  disposition: DispositionSchema,
  /** Named failure mode this case protects (required for frozen). */
  failure_mode: z.string().min(1),
  adjudicator_rationale: z.string().min(1),
  evidence_urls: z.array(z.string().url()).min(1),
  required_findings: z.array(z.string().min(1)).default([]),
  forbidden_findings: z.array(z.string().min(1)).default([]),
  required_signals: z.array(z.string().min(1)).default([]),
  forbidden_signals: z.array(z.string().min(1)).default([]),
  routing: z.object({
    primary_mode: ContributionModeSchema,
    acceptable_modes: z.array(ContributionModeSchema).default([]),
    forbidden_modes: z.array(ContributionModeSchema).default([]),
    build_contention: BuildContentionSchema.optional()
  }).strict().optional()
}).strict();

export const EvalCaseClassificationSchema = z.enum([
  'frozen',
  'promote_candidate',
  'live_only',
  'retired'
]);

export const EvalProvenanceSchema = z.object({
  capture_id: z.string().min(1).optional(),
  capture_created_at: z.string().datetime().optional(),
  source_issue_urls: z.array(z.string().url()).default([]),
  notes: z.string().optional()
}).strict();

export const EvalCaseSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  case_version: z.literal(EVAL_CASE_VERSION),
  id: z.string().min(1),
  suite: EvalSuiteSchema,
  name: z.string().min(1),
  function: EvalCommandSchema,
  input: z.record(z.string(), z.unknown()),
  classification: EvalCaseClassificationSchema,
  /** Soft expectations used by the live suite (never auto-promoted to ground truth). */
  expect: EvalLiveExpectationSchema.optional(),
  /** Human-reviewed ground truth; required when suite === 'frozen'. */
  ground_truth: EvalGroundTruthSchema.optional(),
  provenance: EvalProvenanceSchema.optional(),
  time_sensitive: z.boolean().default(false),
  /** Relative path from the case file to a provider fixture pack (frozen/private). */
  provider_fixtures: z.string().min(1).optional(),
  note: z.string().optional()
}).strict().superRefine((value, ctx) => {
  if (value.suite === 'frozen') {
    if (!value.ground_truth) {
      ctx.addIssue({ code: 'custom', path: ['ground_truth'], message: 'frozen cases require human-reviewed ground_truth' });
    }
    if (!value.provider_fixtures) {
      ctx.addIssue({ code: 'custom', path: ['provider_fixtures'], message: 'frozen cases require provider_fixtures' });
    }
    if (value.classification !== 'frozen') {
      ctx.addIssue({ code: 'custom', path: ['classification'], message: 'frozen suite cases must have classification=frozen' });
    }
  }
  if (value.suite === 'private' && value.classification === 'frozen') {
    ctx.addIssue({
      code: 'custom',
      path: ['classification'],
      message: 'private cases cannot be classification=frozen; promote explicitly into eval/frozen'
    });
  }
});

export const EvalCaseCatalogSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  case_version: z.literal(EVAL_CASE_VERSION),
  suite: EvalSuiteSchema,
  cases: z.array(EvalCaseSchema).min(1)
}).strict().superRefine((catalog, ctx) => {
  for (const [index, item] of catalog.cases.entries()) {
    if (item.suite !== catalog.suite) {
      ctx.addIssue({
        code: 'custom',
        path: ['cases', index, 'suite'],
        message: `case suite ${item.suite} does not match catalog suite ${catalog.suite}`
      });
    }
  }
});

export const EvalRowStatusSchema = z.enum([
  'passed',
  'failed',
  'drifted',
  'blocked',
  'provider_failure',
  'auth_limitation',
  'product_regression'
]);

/** Optional per-row adjudication fields populated by frozen suite runs (GW-023). */
export const EvalSuiteReportRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: EvalRowStatusSchema,
  detail: z.string(),
  failure_mode: z.string().optional(),
  function: EvalCommandSchema.optional(),
  repo: z.string().min(1).optional(),
  expected_verdict: VerdictSchema.optional(),
  observed_verdict: VerdictSchema.optional(),
  expected_disposition: DispositionSchema.optional(),
  observed_disposition: DispositionSchema.optional(),
  /** True when observed SKIP is backed by a definitive blocking finding. */
  hard_skip: z.boolean().optional(),
  verify_reason: z.string().min(1).optional(),
  duration_ms: z.number().nonnegative().optional(),
  github_requests: z.number().int().nonnegative().optional(),
  schema_valid: z.boolean().optional()
}).strict();

export const EvalSuiteReportSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  suite: EvalSuiteSchema,
  release_blocking: z.boolean(),
  generated_at: z.string().datetime(),
  gitworthy_version: z.string().min(1),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    drifted: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    provider_failure: z.number().int().nonnegative(),
    auth_limitation: z.number().int().nonnegative(),
    product_regression: z.number().int().nonnegative()
  }),
  rows: z.array(EvalSuiteReportRowSchema),
  notes: z.array(z.string()).default([])
}).strict();

/** Versioned eval quality report contract (GW-023). */
export const EVAL_REPORT_VERSION = 1 as const;

export const EvalMilestoneSchema = z.enum(['0.6.0', '0.7.0', '0.8.0', '0.9.0', '1.0.0']);

export const EvalReleaseGateStatusSchema = z.enum(['pass', 'fail', 'warn']);

export const EvalReleaseGateSchema = z.object({
  id: z.string().min(1),
  status: EvalReleaseGateStatusSchema,
  message: z.string().min(1),
  threshold: z.string().optional(),
  observed: z.string().optional(),
  case_ids: z.array(z.string().min(1)).default([])
}).strict();

export const EvalPrecisionMetricsSchema = z.object({
  true_positive: z.number().int().nonnegative(),
  false_positive: z.number().int().nonnegative(),
  false_negative: z.number().int().nonnegative(),
  /** null when denominator is zero (no observed decisions in class). */
  precision: z.number().min(0).max(1).nullable(),
  denominator: z.number().int().nonnegative()
}).strict();

export const EvalQualityMetricsSchema = z.object({
  adjudicated_cases: z.number().int().nonnegative(),
  verdict_cases: z.number().int().nonnegative(),
  mechanism_only_cases: z.number().int().nonnegative(),
  unadjudicated_cases: z.number().int().nonnegative(),
  duplicate_case_ids: z.array(z.string().min(1)),
  stale_case_ids: z.array(z.string().min(1)),
  incomplete_case_ids: z.array(z.string().min(1)),
  hard_skip: EvalPrecisionMetricsSchema,
  act: EvalPrecisionMetricsSchema,
  false_hard_skip_count: z.number().int().nonnegative(),
  false_act_count: z.number().int().nonnegative(),
  verify_by_reason: z.record(z.string(), z.number().int().nonnegative()),
  schema_failure_count: z.number().int().nonnegative(),
  counts_by_verdict: z.record(VerdictSchema, z.number().int().nonnegative()),
  counts_by_disposition: z.record(DispositionSchema, z.number().int().nonnegative()),
  counts_by_failure_mode: z.record(z.string(), z.number().int().nonnegative()),
  counts_by_repository: z.record(z.string(), z.number().int().nonnegative()),
  counts_by_row_status: z.record(EvalRowStatusSchema, z.number().int().nonnegative()),
  duration_ms: z.object({
    available: z.number().int().nonnegative(),
    median: z.number().nonnegative().nullable(),
    p95: z.number().nonnegative().nullable()
  }).strict(),
  github_requests: z.object({
    available: z.number().int().nonnegative(),
    median: z.number().nonnegative().nullable(),
    p95: z.number().nonnegative().nullable()
  }).strict(),
  coverage_gaps: z.object({
    failure_modes: z.array(z.string().min(1)),
    hard_skip_paths: z.array(z.string().min(1)),
    error_classes: z.array(z.string().min(1))
  }).strict()
}).strict();

export const EvalCaseTraceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: EvalRowStatusSchema,
  failure_mode: z.string().optional(),
  expected_verdict: VerdictSchema.optional(),
  observed_verdict: VerdictSchema.optional(),
  hard_skip: z.boolean().optional(),
  false_hard_skip: z.boolean().optional(),
  false_act: z.boolean().optional(),
  verify_reason: z.string().optional(),
  detail: z.string().min(1)
}).strict();

export const EvalQualityReportSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  report_version: z.literal(EVAL_REPORT_VERSION),
  milestone: EvalMilestoneSchema,
  suite: z.literal('frozen'),
  generated_at: z.string().datetime(),
  gitworthy_version: z.string().min(1),
  source: z.object({
    suite_report: z.string().min(1),
    case_catalog: z.string().min(1)
  }).strict(),
  release_status: EvalReleaseGateStatusSchema,
  gates: z.array(EvalReleaseGateSchema),
  metrics: EvalQualityMetricsSchema,
  cases: z.array(EvalCaseTraceSchema),
  summary_text: z.string().min(1)
}).strict();

/** Milestone release thresholds (GW-023). WARN until corpus grows; FAIL on false hard SKIP. */
export const EVAL_MILESTONE_THRESHOLDS = {
  '0.6.0': {
    min_adjudicated_cases: 30,
    min_repositories: 0,
    min_act_precision: null,
    max_false_hard_skip: 0,
    required_hard_skip_paths: [] as string[],
    required_failure_modes: [] as string[],
    required_error_classes: [] as string[]
  },
  '0.7.0': {
    min_adjudicated_cases: 60,
    min_repositories: 10,
    min_act_precision: null,
    max_false_hard_skip: 0,
    required_hard_skip_paths: ['released_fix', 'linked_pr_open'],
    required_failure_modes: [] as string[],
    required_error_classes: [] as string[]
  },
  '0.8.0': {
    min_adjudicated_cases: 75,
    min_repositories: 10,
    min_act_precision: null,
    max_false_hard_skip: 0,
    required_hard_skip_paths: ['released_fix', 'linked_pr_open'],
    required_failure_modes: [] as string[],
    required_error_classes: [] as string[]
  },
  '0.9.0': {
    min_adjudicated_cases: 125,
    min_repositories: 20,
    min_act_precision: null,
    max_false_hard_skip: 0,
    required_hard_skip_paths: ['released_fix', 'linked_pr_open'],
    required_failure_modes: [] as string[],
    required_error_classes: ['provider_failure', 'auth_limitation']
  },
  '1.0.0': {
    min_adjudicated_cases: 150,
    min_repositories: 20,
    min_act_precision: 0.9,
    max_false_hard_skip: 0,
    required_hard_skip_paths: ['released_fix', 'linked_pr_open'],
    required_failure_modes: [] as string[],
    required_error_classes: ['provider_failure', 'auth_limitation']
  }
} as const;

export type EvalSuite = z.infer<typeof EvalSuiteSchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalCaseCatalog = z.infer<typeof EvalCaseCatalogSchema>;
export type EvalGroundTruth = z.infer<typeof EvalGroundTruthSchema>;
export type EvalSuiteReport = z.infer<typeof EvalSuiteReportSchema>;
export type EvalSuiteReportRow = z.infer<typeof EvalSuiteReportRowSchema>;
export type EvalRowStatus = z.infer<typeof EvalRowStatusSchema>;
export type EvalMilestone = z.infer<typeof EvalMilestoneSchema>;
export type EvalReleaseGate = z.infer<typeof EvalReleaseGateSchema>;
export type EvalReleaseGateStatus = z.infer<typeof EvalReleaseGateStatusSchema>;
export type EvalQualityMetrics = z.infer<typeof EvalQualityMetricsSchema>;
export type EvalQualityReport = z.infer<typeof EvalQualityReportSchema>;
export type EvalCaseTrace = z.infer<typeof EvalCaseTraceSchema>;
