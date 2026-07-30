import { z } from 'zod';
import { randomUUID } from 'node:crypto';

/** Pre-1.0 draft contract id. Incompatible draft changes increment the suffix. */
export const SCHEMA_VERSION = '1.0-draft.1' as const;

export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);

export const VerdictSchema = z.enum(['ACT', 'VERIFY', 'SKIP']);
export const DispositionSchema = z.enum(['greenfield', 'land_only', 'claim_first', 'blocked', 'crowded', 'review']);

export const CheckStatusSchema = z.enum(['complete', 'skipped', 'failed', 'not_applicable']);

export const CheckCoverageSchema = z.object({
  id: z.string().min(1),
  status: CheckStatusSchema,
  duration_ms: z.number().nonnegative().optional(),
  cached: z.boolean().optional()
});

export const MetricsSchema = z.object({
  duration_ms: z.number().nonnegative().optional(),
  github_requests: z.number().int().nonnegative().optional(),
  git_commands: z.number().int().nonnegative().optional(),
  bytes_read: z.number().int().nonnegative().optional(),
  cache_hits: z.number().int().nonnegative().optional()
}).catchall(z.unknown());

export const CommonResultCoreSchema = z.object({
  schema_version: SchemaVersionSchema,
  gitworthy_version: z.string().min(1),
  command: z.string().min(1),
  run_id: z.string().min(1),
  generated_at: z.string().datetime(),
  cached: z.boolean(),
  summary: z.string().min(1),
  checked: z.array(z.string()).min(1),
  not_checked: z.array(z.string()).min(1),
  checks: z.array(CheckCoverageSchema).default([]),
  findings: z.array(z.unknown()).default([]),
  metrics: MetricsSchema.default({})
});

export type CommonResultCore = z.infer<typeof CommonResultCoreSchema>;

export function newRunId(): string {
  return `run_${randomUUID().replace(/-/g, '')}`;
}

export function newDecisionId(): string {
  return `decision_${randomUUID().replace(/-/g, '')}`;
}

export function newFindingId(): string {
  return `finding_${randomUUID().replace(/-/g, '')}`;
}
