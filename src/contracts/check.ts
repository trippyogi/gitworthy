import { z } from 'zod';
import { CommonResultCoreSchema, DispositionSchema, VerdictSchema } from './common.js';
import { FindingSchema } from './findings.js';
import { RoutingDecisionSchema, SourceSnapshotSchema } from './routing.js';

export const NextActionSchema = z.object({
  kind: z.string().min(1),
  message: z.string().min(1)
});

export const TargetIdentitySchema = z.object({
  input_repo: z.string().min(1),
  canonical_repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  issue_state: z.string().optional(),
  issue_url: z.string().optional(),
  head_sha: z.string().optional()
});

/** Legacy evidence / signal fields retained through the pre-1.0 compatibility period. */
export const LegacyCompatibilitySchema = z.object({
  verdict_summary: z.string().optional(),
  evidence: z.array(z.record(z.string(), z.unknown())).optional(),
  signals: z.array(z.string()).optional(),
  reasons: z.array(z.string()).optional(),
  sub_results: z.array(z.unknown()).optional(),
  timings_ms: z.record(z.string(), z.number()).optional(),
  perf: z.record(z.string(), z.unknown()).optional(),
  fetched_at: z.string().datetime().optional()
}).partial();

export const CheckResultSchema = CommonResultCoreSchema.extend({
  command: z.literal('check'),
  decision_id: z.string().min(1),
  target: TargetIdentitySchema,
  verdict: VerdictSchema,
  disposition: DispositionSchema,
  next_actions: z.array(NextActionSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  routing: RoutingDecisionSchema.optional(),
  source_snapshot: SourceSnapshotSchema.optional()
}).merge(LegacyCompatibilitySchema);

export type CheckResult = z.infer<typeof CheckResultSchema>;
