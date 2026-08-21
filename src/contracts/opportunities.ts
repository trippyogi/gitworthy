import { z } from 'zod';
import { RepoRefSchema } from './inputs.js';

/**
 * Generic opportunity identity for portfolio/PR/eval surfaces.
 * Do not replace the legacy issue-only TargetIdentitySchema.
 */
export const OpportunityTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('issue'),
    repo: RepoRefSchema,
    issue_number: z.number().int().positive()
  }).strict(),
  z.object({
    kind: z.literal('pull_request'),
    repo: RepoRefSchema,
    pr_number: z.number().int().positive(),
    linked_issue_number: z.number().int().positive().optional()
  }).strict(),
  z.object({
    kind: z.literal('eval_anomaly'),
    repo: RepoRefSchema.optional(),
    external_id: z.string().min(1),
    source: z.string().min(1)
  }).strict()
]);

export type OpportunityTarget = z.infer<typeof OpportunityTargetSchema>;
