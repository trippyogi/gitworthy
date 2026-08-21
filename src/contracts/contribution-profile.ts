import { z } from 'zod';

export const PlatformHintSchema = z.enum(['windows', 'linux', 'macos', 'wsl', 'container']);

export const ContributionDomainSchema = z.object({
  id: z.string().min(1),
  terms: z.array(z.string().min(1)).min(1),
  weight: z.number().positive().default(1)
}).strict();

export const ContributionWipLimitsSchema = z.object({
  BUILD: z.number().int().nonnegative().optional(),
  REVIEW: z.number().int().nonnegative().optional(),
  SALVAGE: z.number().int().nonnegative().optional(),
  REPRODUCE: z.number().int().nonnegative().optional(),
  EVAL: z.number().int().nonnegative().optional(),
  DOC: z.number().int().nonnegative().optional(),
  WATCH: z.number().int().nonnegative().optional(),
  PASS: z.number().int().nonnegative().optional(),
  deep_investigation: z.number().int().nonnegative().optional()
}).strict();

export const ContributionProfileSchema = z.object({
  mode_weights: z.object({
    BUILD: z.number().min(0).max(2).optional(),
    REVIEW: z.number().min(0).max(2).optional(),
    SALVAGE: z.number().min(0).max(2).optional(),
    REPRODUCE: z.number().min(0).max(2).optional(),
    EVAL: z.number().min(0).max(2).optional(),
    DOC: z.number().min(0).max(2).optional(),
    WATCH: z.number().min(0).max(2).optional(),
    PASS: z.number().min(0).max(2).optional()
  }).strict().default({}),
  domains: z.array(ContributionDomainSchema).default([]),
  platforms: z.array(PlatformHintSchema).default([]),
  wip_limits: ContributionWipLimitsSchema.default({}),
  stale_pr_days: z.number().int().positive().default(14)
}).strict();

export type PlatformHint = z.infer<typeof PlatformHintSchema>;
export type ContributionDomain = z.infer<typeof ContributionDomainSchema>;
export type ContributionWipLimits = z.infer<typeof ContributionWipLimitsSchema>;
export type ContributionProfile = z.infer<typeof ContributionProfileSchema>;
