import { z } from 'zod';
import { OpportunityTargetSchema } from './opportunities.js';

export const WATCH_VERSION = 1 as const;

export const WatchTriggerSchema = z.enum([
  'target_state_changed',
  'new_pr',
  'pr_state_changed',
  'ci_changed',
  'maintainer_activity',
  'staleness_threshold',
  'manual'
]);

export const WatchSnapshotSchema = z.object({
  issue_state: z.string().optional(),
  issue_updated_at: z.string().optional(),
  assignees: z.array(z.string()).default([]),
  linked_prs: z.array(z.object({
    number: z.number().int().positive(),
    state: z.string(),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    updated_at: z.string().optional()
  })).default([]),
  ci_state: z.string().optional(),
  maintainer_activity_at: z.string().optional()
}).strict();

export const WatchRecordSchema = z.object({
  watch_version: z.literal(WATCH_VERSION),
  watch_id: z.string().min(1),
  target: OpportunityTargetSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_fingerprint: z.string().min(1),
  last_snapshot: WatchSnapshotSchema,
  note: z.string().optional()
}).strict();

export const WatchFieldDeltaSchema = z.object({
  path: z.string().min(1),
  before: z.unknown(),
  after: z.unknown()
}).strict();

export const WatchRecheckSchema = z.object({
  watch_id: z.string().min(1),
  changed: z.boolean(),
  triggers: z.array(WatchTriggerSchema).default([]),
  deltas: z.array(WatchFieldDeltaSchema).default([]),
  fingerprint_before: z.string(),
  fingerprint_after: z.string(),
  updated: z.boolean()
}).strict();

export type WatchTrigger = z.infer<typeof WatchTriggerSchema>;
export type WatchSnapshot = z.infer<typeof WatchSnapshotSchema>;
export type WatchRecord = z.infer<typeof WatchRecordSchema>;
export type WatchRecheck = z.infer<typeof WatchRecheckSchema>;
