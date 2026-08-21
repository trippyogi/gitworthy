import { z } from 'zod';
import { OpportunityTargetSchema } from './opportunities.js';

export const PR_SCAN_VERSION = 1 as const;
export const PR_INVENTORY_LIMIT = 25 as const;
export const PR_ENRICH_LIMIT = 5 as const;

export const PrScanFilterSchema = z.object({
  include_bots: z.boolean().default(false),
  include_merged: z.boolean().default(false),
  include_drafts: z.boolean().default(true),
  include_generated: z.boolean().default(false),
  stale_pr_days: z.number().int().positive().default(14),
  inventory_limit: z.number().int().positive().max(PR_INVENTORY_LIMIT).default(PR_INVENTORY_LIMIT),
  enrich_limit: z.number().int().nonnegative().max(PR_ENRICH_LIMIT).default(PR_ENRICH_LIMIT)
}).strict();

export const PrHintModeSchema = z.enum(['REVIEW', 'WATCH', 'SALVAGE', 'PASS']);

export const PrInventoryItemSchema = z.object({
  target: OpportunityTargetSchema,
  repo: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string().nullable(),
  draft: z.boolean(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  linked_issue_number: z.number().int().positive().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  review_state: z.string().optional(),
  ci_state: z.string().optional(),
  cheap_rank: z.number().min(0).max(1),
  filtered_reason: z.string().optional()
}).strict();

export const PrEnrichmentSchema = z.object({
  linked_issue_number: z.number().int().positive().optional(),
  issue_open: z.boolean().optional(),
  closes_issue: z.boolean().default(false),
  review_states: z.array(z.string()).default([]),
  maintainer_reviewed: z.boolean().default(false),
  maintainer_positive_review: z.boolean().default(false),
  requested_changes: z.boolean().default(false),
  approved: z.boolean().default(false),
  ci_state: z.enum(['success', 'failure', 'pending', 'unknown']).default('unknown'),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  touched_paths: z.array(z.string()).default([]),
  has_tests: z.boolean().default(false),
  competing_closers: z.number().int().nonnegative().default(0),
  contention_gaps: z.array(z.string()).default([]),
  stale: z.boolean().default(false),
  stale_days: z.number().nonnegative().optional(),
  maintainer_interest: z.boolean().default(false),
  substantive: z.boolean().default(false),
  credible_work: z.boolean().default(false),
  healthy_active: z.boolean().default(false),
  looks_like_bug: z.boolean().default(false),
  cross_platform: z.boolean().default(false),
  enormous_refactor: z.boolean().default(false)
}).strict();

export const PrOpportunitySchema = z.object({
  target: OpportunityTargetSchema,
  inventory: PrInventoryItemSchema,
  enriched: z.boolean(),
  enrichment: PrEnrichmentSchema.optional(),
  hint_mode: PrHintModeSchema,
  hint_reasons: z.array(z.string()).default([]),
  hard_constraints: z.array(z.string()).default([]),
  salvage_facts: z.object({
    substantive_prior_attempt: z.boolean(),
    stale_open_pr: z.boolean(),
    maintainer_interest: z.boolean(),
    credible_work_remains: z.boolean(),
    healthy_active_closer: z.boolean(),
    issue_open: z.boolean().optional()
  }).optional()
}).strict();

export const PrScanResultSchema = z.object({
  pr_scan_version: z.literal(PR_SCAN_VERSION),
  repo: z.string().min(1),
  inventory_count: z.number().int().nonnegative(),
  filtered_count: z.number().int().nonnegative(),
  enriched_count: z.number().int().nonnegative(),
  budget_truncated: z.boolean().default(false),
  opportunities: z.array(PrOpportunitySchema).default([]),
  checked: z.array(z.string()).default([]),
  not_checked: z.array(z.string()).default([])
}).strict();

export type PrScanFilter = z.infer<typeof PrScanFilterSchema>;
export type PrInventoryItem = z.infer<typeof PrInventoryItemSchema>;
export type PrEnrichment = z.infer<typeof PrEnrichmentSchema>;
export type PrOpportunity = z.infer<typeof PrOpportunitySchema>;
export type PrScanResult = z.infer<typeof PrScanResultSchema>;
export type PrHintMode = z.infer<typeof PrHintModeSchema>;
