import { z } from 'zod';
import { DispositionSchema, SCHEMA_VERSION, SchemaVersionSchema, VerdictSchema } from './common.js';
import { FindingSchema } from './findings.js';
import { NextActionSchema, TargetIdentitySchema } from './check.js';
import { OutcomeEventSchema } from './outcomes.js';

export const STORE_RECORD_VERSION = 1 as const;

export const StoreTargetSchema = z.object({
  repo: z.string().min(1),
  issue_number: z.number().int().positive()
});

/** Durable run metadata written after a command completes. */
export const RunRecordSchema = z.object({
  record_version: z.literal(STORE_RECORD_VERSION),
  record_kind: z.literal('run'),
  run_id: z.string().min(1),
  command: z.string().min(1),
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  gitworthy_version: z.string().min(1),
  generated_at: z.string().datetime(),
  cached: z.boolean().default(false),
  summary: z.string().min(1),
  target: StoreTargetSchema.optional(),
  decision_id: z.string().optional(),
  checked: z.array(z.string()).default([]),
  not_checked: z.array(z.string()).default([]),
  metrics: z.record(z.string(), z.unknown()).default({})
});

/** Durable decision snapshot tied to a run + target. */
export const DecisionRecordSchema = z.object({
  record_version: z.literal(STORE_RECORD_VERSION),
  record_kind: z.literal('decision'),
  decision_id: z.string().min(1),
  run_id: z.string().min(1),
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  gitworthy_version: z.string().min(1),
  created_at: z.string().datetime(),
  target: TargetIdentitySchema,
  verdict: VerdictSchema,
  disposition: DispositionSchema,
  next_actions: z.array(NextActionSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  reasons: z.array(z.string()).default([]),
  signals: z.array(z.string()).default([])
});

export const TargetIndexSchema = z.object({
  record_version: z.literal(STORE_RECORD_VERSION),
  record_kind: z.literal('target_index'),
  target: StoreTargetSchema,
  updated_at: z.string().datetime(),
  run_ids: z.array(z.string()).default([]),
  decision_ids: z.array(z.string()).default([]),
  outcome_ids: z.array(z.string()).default([])
});

export type RunRecord = z.infer<typeof RunRecordSchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
export type TargetIndex = z.infer<typeof TargetIndexSchema>;
export type OutcomeEvent = z.infer<typeof OutcomeEventSchema>;
