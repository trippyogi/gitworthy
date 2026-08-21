import { z } from 'zod';
import { DispositionSchema, VerdictSchema } from './common.js';
import { NextActionSchema } from './check.js';
import type { Finding } from './findings.js';
import type { ContentionReport } from './contention.js';

export const ROUTING_VERSION = 1 as const;

export const ContributionModeSchema = z.enum([
  'BUILD',
  'REVIEW',
  'SALVAGE',
  'REPRODUCE',
  'EVAL',
  'DOC',
  'WATCH',
  'PASS'
]);

export const BuildContentionSchema = z.enum(['GREEN', 'YELLOW', 'RED']);

export const RoutingConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const EffortBucketSchema = z.enum([
  'fast',
  'medium',
  'deep',
  'research',
  'unknown'
]);

export const RoutingCoverageSchema = z.object({
  mandatory_checks_complete: z.boolean(),
  failed_checks: z.array(z.string()).default([]),
  skipped_checks: z.array(z.string()).default([]),
  budget_truncated: z.boolean().default(false),
  rate_limit_degraded: z.boolean().default(false),
  snapshot_age_ms: z.number().nonnegative().optional(),
  advisory_missing: z.array(z.string()).default([])
}).strict();

export const RoutingAlternateModeSchema = z.object({
  mode: ContributionModeSchema,
  score: z.number().min(0).max(1),
  reason: z.string()
}).strict();

export const EvidenceabilitySchema = z.object({
  score: z.number().min(0).max(1),
  reasons: z.array(z.string())
}).strict();

export const RoutingDecisionSchema = z.object({
  routing_version: z.literal(ROUTING_VERSION),
  primary_mode: ContributionModeSchema,
  alternate_modes: z.array(RoutingAlternateModeSchema).default([]),
  build_contention: BuildContentionSchema,
  confidence: RoutingConfidenceSchema,
  reasons: z.array(z.string()),
  hard_constraints: z.array(z.string()).default([]),
  next_actions: z.array(NextActionSchema).default([]),
  evidenceability: EvidenceabilitySchema,
  effort_bucket: EffortBucketSchema.default('unknown'),
  coverage: RoutingCoverageSchema
}).strict();

export type ContributionMode = z.infer<typeof ContributionModeSchema>;
export type BuildContention = z.infer<typeof BuildContentionSchema>;
export type RoutingConfidence = z.infer<typeof RoutingConfidenceSchema>;
export type EffortBucket = z.infer<typeof EffortBucketSchema>;
export type RoutingCoverage = z.infer<typeof RoutingCoverageSchema>;
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;
export type Evidenceability = z.infer<typeof EvidenceabilitySchema>;

export type ReproHint = 'present' | 'weak' | 'missing';

/** Normalized facts consumed by routeContribution. Counts are caller-normalized. */
export type RouteLinkedFacts = {
  activeClosers: number;
  activeRelatedPrs: number;
  closedUnmergedAttempts: number;
  mergedClosers: number;
  assigned: boolean;
  claimRequired: boolean;
  issueOpen?: boolean;
  fullyResolved?: boolean;
  substantivePriorAttempt?: boolean;
  staleOpenPr?: boolean;
  maintainerInterest?: boolean;
  credibleWorkRemains?: boolean;
  healthyActiveCloser?: boolean;
};

export type RouteQualityFacts = {
  looksLikeBug: boolean;
  repro: ReproHint;
  softAsk: boolean;
};

export type RouteCategoryHints = {
  documentation: boolean;
  evaluation: boolean;
};

export type RouteContentionFacts = Pick<ContentionReport, 'state' | 'low_confidence'> & {
  truncated?: boolean;
};

export type RouteFacts = {
  verdict: z.infer<typeof VerdictSchema>;
  disposition: z.infer<typeof DispositionSchema>;
  findings: Finding[];
  mandatoryFailures: string[];
  linked: RouteLinkedFacts;
  contention?: RouteContentionFacts | ContentionReport;
  quality?: RouteQualityFacts;
  categoryHints?: RouteCategoryHints;
  coverage: RoutingCoverage;
};
