import { z } from 'zod';
import { CloseReasonSchema, OutcomeEventNameSchema } from './outcomes.js';
import { VerdictSchema } from './common.js';

/**
 * Track O contracts (outcome corpus / verdict calibration).
 * Verdict path code must never import covariates — only this module and `src/lib/track-o-covariates.ts`.
 */

export const TRACK_O_COVARIATES_VERSION = 1 as const;

/** Join key: decision_id is primary; extend the existing store (no parallel log). */
export const TrackOJoinKeySchema = z.object({
  decision_id: z.string().min(1),
  run_id: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  pr_url: z.string().url().nullable().default(null)
}).strict();

/**
 * Optional analysis covariates captured at check time.
 * Never readable by the verdict path (worth_check / hunt / linked_work / …).
 */
export const TrackOCovariatesFieldsSchema = z.object({
  contributor_count: z.number().int().nonnegative().optional(),
  open_pr_backlog: z.number().int().nonnegative().optional(),
  median_time_to_first_review_hours: z.number().nonnegative().optional(),
  maintainer_commented_on_issue: z.boolean().optional(),
  issue_age_hours: z.number().nonnegative().optional(),
  linked_pr_count_at_check: z.number().int().nonnegative().optional(),
  contributing_md_present: z.boolean().optional(),
  author_prior_merged_prs: z.number().int().nonnegative().optional(),
  planned_diff_scope_note: z.string().optional()
}).strict();

export const TrackOCovariatesRecordSchema = z.object({
  record_version: z.literal(TRACK_O_COVARIATES_VERSION),
  record_kind: z.literal('track_o_covariates'),
  decision_id: z.string().min(1),
  run_id: z.string().min(1),
  target: z.object({
    repo: z.string().min(1),
    issue_number: z.number().int().positive()
  }),
  captured_at: z.string().datetime(),
  /** True for Phase 2 backfills with no live T0 snapshot. */
  reconstructed: z.boolean().default(false),
  covariates: TrackOCovariatesFieldsSchema.default({}),
  /** Documentation marker: every field above must have been knowable at T0. */
  knowable_at_t0: z.literal(true).default(true)
}).strict();

export const TrackOOutcomeColumnSchema = z.enum([
  'merged',
  'rejected',
  'superseded',
  'stale_or_withdrawn'
]);

export const TrackOContingencyCellSchema = z.object({
  count: z.number().int().nonnegative()
}).strict();

/** Contingency table: verdict at T0 × outcome at T1. Not an accuracy score. */
export const TrackOContingencyTableSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string().datetime(),
  /** Snapshot-backed rows only in headline tables; reconstructed stay separate. */
  partition: z.enum(['snapshot_backed', 'reconstructed']),
  rows: z.object({
    ACT: z.record(TrackOOutcomeColumnSchema, TrackOContingencyCellSchema),
    VERIFY: z.record(TrackOOutcomeColumnSchema, TrackOContingencyCellSchema),
    SKIP_acted_against: z.record(TrackOOutcomeColumnSchema, TrackOContingencyCellSchema)
  }),
  metrics: z.object({
    act_precision: z.number().min(0).max(1).nullable(),
    skip_validation_merge_rate: z.number().min(0).max(1).nullable(),
    superseded_rate_under_act: z.number().min(0).max(1).nullable(),
    acted_on_denominator: z.number().int().nonnegative(),
    notes: z.array(z.string()).default([])
  })
}).strict();

/** Worked example row shape for docs / Phase 0 evidence. */
export const TrackOExampleRowSchema = z.object({
  join: TrackOJoinKeySchema,
  verdict_at_t0: VerdictSchema,
  disposition_at_t0: z.string().min(1),
  acted_on: z.boolean(),
  outcome_event: OutcomeEventNameSchema,
  close_reason: CloseReasonSchema.optional(),
  acted_against_skip: z.boolean().default(false),
  reconstructed: z.boolean().default(false)
}).strict();

export type TrackOJoinKey = z.infer<typeof TrackOJoinKeySchema>;
export type TrackOCovariatesRecord = z.infer<typeof TrackOCovariatesRecordSchema>;
export type TrackOCovariatesFields = z.infer<typeof TrackOCovariatesFieldsSchema>;
export type TrackOContingencyTable = z.infer<typeof TrackOContingencyTableSchema>;
