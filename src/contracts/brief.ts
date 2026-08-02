import { z } from 'zod';
import { NextActionSchema, TargetIdentitySchema } from './check.js';
import { DispositionSchema, VerdictSchema } from './common.js';
import { FindingSchema } from './findings.js';

export const BRIEF_SCHEMA_VERSION = 'brief.v1' as const;
export const BRIEF_RENDERING_VERSION = 'brief-human.v1' as const;

export const BriefFormatSchema = z.enum(['human', 'json', 'markdown']);

const BriefItemSchema = z.object({
  type: z.string().min(1),
  message: z.string().min(1),
  url: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({})
});

export const BriefStalenessWarningSchema = z.object({
  stale: z.boolean(),
  threshold_hours: z.number().int().positive(),
  age_hours: z.number().int().nonnegative(),
  basis: z.string().datetime(),
  warning: z.string().optional(),
  recommend: z.literal('recheck').optional()
});

export const BriefConfigProvenanceSchema = z.object({
  schema_version: z.string().min(1),
  profile: z.object({
    value: z.unknown(),
    provenance: z.record(z.string(), z.unknown()).optional()
  }).optional(),
  manifest: z.object({
    path: z.string().optional(),
    provenance: z.record(z.string(), z.unknown()).optional(),
    summary: z.object({
      repos: z.number().int().nonnegative(),
      orgs: z.number().int().nonnegative(),
      package_mappings: z.number().int().nonnegative()
    })
  }).optional(),
  loaded: z.array(z.object({
    layer: z.string().min(1),
    path: z.string().min(1),
    present: z.boolean()
  })).default([])
});

export const BriefSourceRecordsSchema = z.object({
  decision_id: z.string().min(1),
  run_id: z.string().min(1),
  run_found: z.boolean(),
  outcome_ids: z.array(z.string()).default([])
});

export const BriefSchema = z.object({
  brief_schema_version: z.literal(BRIEF_SCHEMA_VERSION),
  rendering_version: z.literal(BRIEF_RENDERING_VERSION),
  command: z.literal('brief'),
  target: TargetIdentitySchema,
  verdict: VerdictSchema,
  disposition: DispositionSchema,
  summary: z.string().min(1),
  source_records: BriefSourceRecordsSchema,
  decision_created_at: z.string().datetime(),
  run_generated_at: z.string().datetime().optional(),
  ranked_findings: z.array(FindingSchema),
  contribution_policy: z.array(BriefItemSchema).default([]),
  claim_requirements: z.array(BriefItemSchema).default([]),
  linked_work: z.array(BriefItemSchema).default([]),
  prior_attempts: z.array(BriefItemSchema).default([]),
  named_paths_symbols: z.object({
    paths: z.array(z.string()).default([]),
    symbols: z.array(z.string()).default([])
  }),
  checks_not_completed: z.array(z.string()).default([]),
  evidence_urls: z.array(z.string()).default([]),
  next_actions: z.array(NextActionSchema).default([]),
  stop_conditions: z.array(z.string()).default([]),
  staleness_warning: BriefStalenessWarningSchema,
  config_provenance: BriefConfigProvenanceSchema.optional()
});

export const BriefInputSchema = z.object({
  decision_id: z.string().min(1),
  config_path: z.string().optional(),
  cwd: z.string().optional()
}).strict();

export type Brief = z.infer<typeof BriefSchema>;
export type BriefFormat = z.infer<typeof BriefFormatSchema>;
export type BriefInput = z.infer<typeof BriefInputSchema>;
