import { z } from 'zod';
import { DispositionSchema, SCHEMA_VERSION, SchemaVersionSchema, VerdictSchema } from './common.js';

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
  forbidden_signals: z.array(z.string().min(1)).default([])
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
  rows: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: EvalRowStatusSchema,
    detail: z.string(),
    failure_mode: z.string().optional()
  })),
  notes: z.array(z.string()).default([])
}).strict();

export type EvalSuite = z.infer<typeof EvalSuiteSchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalCaseCatalog = z.infer<typeof EvalCaseCatalogSchema>;
export type EvalGroundTruth = z.infer<typeof EvalGroundTruthSchema>;
export type EvalSuiteReport = z.infer<typeof EvalSuiteReportSchema>;
export type EvalRowStatus = z.infer<typeof EvalRowStatusSchema>;
