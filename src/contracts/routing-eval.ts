import { z } from 'zod';
import { BuildContentionSchema, ContributionModeSchema } from './routing.js';

export const DecisionAccelerationSchema = z.object({
  from_mode: ContributionModeSchema,
  to_mode: ContributionModeSchema,
  hours_saved: z.number().nonnegative(),
  reason: z.string().min(1)
}).strict();

export const RoutingEvalPartitionSchema = z.enum(['snapshot', 'reconstructed']);

export const RoutingEvalCaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  partition: RoutingEvalPartitionSchema,
  adversarial: z.boolean().default(false),
  facts: z.record(z.string(), z.unknown()),
  expected: z.object({
    primary_mode: ContributionModeSchema,
    acceptable_modes: z.array(ContributionModeSchema).default([]),
    forbidden_modes: z.array(ContributionModeSchema).default([]),
    build_contention: BuildContentionSchema.optional()
  }).strict()
}).strict();

export const RoutingEvalMetricsSchema = z.object({
  routing_cases: z.number().int().nonnegative(),
  snapshot_cases: z.number().int().nonnegative(),
  reconstructed_cases: z.number().int().nonnegative(),
  mode_top1_accuracy: z.number().min(0).max(1).nullable(),
  acceptable_mode_accuracy: z.number().min(0).max(1).nullable(),
  false_build_occupied: z.number().int().nonnegative(),
  false_build_blocked: z.number().int().nonnegative(),
  false_pass_actionable: z.number().int().nonnegative(),
  counts_by_mode: z.record(z.string(), z.number().int().nonnegative()),
  counts_by_contention: z.record(z.string(), z.number().int().nonnegative()),
  counts_by_confidence: z.record(z.string(), z.number().int().nonnegative()),
  headline_excludes_reconstructed: z.literal(true)
}).strict();

export type DecisionAcceleration = z.infer<typeof DecisionAccelerationSchema>;
export type RoutingEvalCase = z.infer<typeof RoutingEvalCaseSchema>;
export type RoutingEvalMetrics = z.infer<typeof RoutingEvalMetricsSchema>;
