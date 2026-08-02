import { z } from 'zod';

/** Additive contention analysis contracts (GW-040+). Absent = pre-contention consumers. */

export const CONTENTION_SCHEMA_VERSION = 1 as const;

export const ContentionStateSchema = z.enum(['uncontested', 'contested', 'superseded', 'resolved']);
export const SwarmRiskSchema = z.enum(['high', 'medium', 'low']);
export const ContentionPostureSchema = z.enum(['race', 'differentiate', 'defer']);
export const GapKindSchema = z.enum([
  'test_coverage',
  'stated_ask',
  'adjacent_risk',
  'scope_excess',
  'uncovered_surface'
]);
export const EquivalenceRelationSchema = z.enum(['same_change', 'overlapping', 'distinct']);

export const ContentionClaimSchema = z.object({
  pr: z.number().int().positive(),
  repo: z.string().min(1),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().default(false),
  merged: z.boolean().default(false),
  author: z.string().nullable(),
  title: z.string(),
  url: z.string().url(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
  closed_at: z.string().datetime().nullable().optional(),
  source: z.enum(['timeline', 'search', 'comment', 'title_overlap', 'branch_name']),
  closes_issue: z.boolean().default(false),
  diff_stat: z.object({
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    changed_files: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional()
  }).optional(),
  touched_paths: z.array(z.string()).default([]),
  touched_symbols: z.array(z.string()).default([])
}).strict();

export const EquivalenceClassSchema = z.object({
  id: z.string().min(1),
  relation: EquivalenceRelationSchema,
  prs: z.array(z.number().int().positive()).min(1),
  representative: z.number().int().positive(),
  shared_paths: z.array(z.string()).default([]),
  shared_symbols: z.array(z.string()).default([]),
  low_confidence: z.boolean().default(false),
  note: z.string().optional()
}).strict();

export const ContentionGapSchema = z.object({
  kind: GapKindSchema,
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  prs: z.array(z.number().int().positive()).default([]),
  symbols: z.array(z.string()).default([]),
  low_confidence: z.boolean().default(false)
}).strict();

export const ContentionProvenanceSchema = z.object({
  bytes_read: z.number().int().nonnegative(),
  artifacts_read: z.number().int().nonnegative(),
  truncated: z.boolean(),
  verdict_count: z.number().int().nonnegative(),
  budget_bytes: z.number().int().positive(),
  footer: z.string().min(1)
}).strict();

export const ContentionReportSchema = z.object({
  contention_version: z.literal(CONTENTION_SCHEMA_VERSION),
  state: ContentionStateSchema,
  claims: z.array(ContentionClaimSchema).default([]),
  equivalence_classes: z.array(EquivalenceClassSchema).default([]),
  gaps: z.array(ContentionGapSchema).default([]),
  swarm_risk: SwarmRiskSchema.optional(),
  posture: ContentionPostureSchema.optional(),
  provenance: ContentionProvenanceSchema,
  low_confidence: z.boolean().default(false)
}).strict();

export type ContentionState = z.infer<typeof ContentionStateSchema>;
export type ContentionClaim = z.infer<typeof ContentionClaimSchema>;
export type EquivalenceClass = z.infer<typeof EquivalenceClassSchema>;
export type ContentionGap = z.infer<typeof ContentionGapSchema>;
export type ContentionProvenance = z.infer<typeof ContentionProvenanceSchema>;
export type ContentionReport = z.infer<typeof ContentionReportSchema>;
export type SwarmRisk = z.infer<typeof SwarmRiskSchema>;
export type ContentionPosture = z.infer<typeof ContentionPostureSchema>;
