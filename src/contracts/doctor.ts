import { z } from 'zod';
import { CommonResultCoreSchema, VerdictSchema } from './common.js';

export const CapabilityStatusSchema = z.enum(['pass', 'warn', 'fail', 'skipped', 'inconclusive']);

export const CapabilitySchema = z.object({
  id: z.string().min(1),
  status: CapabilityStatusSchema,
  summary: z.string().min(1),
  remediation: z.string().min(1).optional(),
  detail: z.record(z.string(), z.unknown()).optional()
});

export const DoctorResultSchema = CommonResultCoreSchema.extend({
  command: z.literal('doctor'),
  capabilities_version: z.number().int().positive().optional(),
  capabilities: z.array(CapabilitySchema).optional(),
  verdict: VerdictSchema.optional()
}).passthrough();

export type DoctorResult = z.infer<typeof DoctorResultSchema>;
