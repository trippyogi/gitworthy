import { z } from 'zod';
import { OpportunityTargetSchema } from './opportunities.js';
import { ContributionModeSchema, RoutingDecisionSchema } from './routing.js';
import { VerdictSchema, DispositionSchema } from './common.js';

export const PORTFOLIO_VERSION = 1 as const;

export const DispatchStateSchema = z.enum([
  'ready',
  'queued_by_capacity',
  'blocked_by_constraint',
  'watching'
]);

export const CapacityConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const PortfolioCapacitySchema = z.object({
  used: z.record(z.string(), z.number().int().nonnegative()),
  limits: z.record(z.string(), z.number().int().nonnegative()),
  confidence: CapacityConfidenceSchema,
  reasons: z.array(z.string()).default([])
}).strict();

export const PortfolioItemSchema = z.object({
  target: OpportunityTargetSchema,
  primary_mode: ContributionModeSchema,
  dispatch_state: DispatchStateSchema,
  score: z.number().min(0).max(1),
  verdict: VerdictSchema.optional(),
  disposition: DispositionSchema.optional(),
  routing: RoutingDecisionSchema.optional(),
  reasons: z.array(z.string()).default([]),
  next_actions: z.array(z.object({
    kind: z.string(),
    message: z.string()
  })).default([])
}).strict();

export type DispatchState = z.infer<typeof DispatchStateSchema>;
export type CapacityConfidence = z.infer<typeof CapacityConfidenceSchema>;
export type PortfolioCapacity = z.infer<typeof PortfolioCapacitySchema>;
export type PortfolioItem = z.infer<typeof PortfolioItemSchema>;
