import { z } from 'zod';

export const FindingStrengthSchema = z.enum(['definitive', 'corroborated', 'heuristic']);
export const FindingEffectSchema = z.enum(['block', 'verify', 'inform']);

export const FindingSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  strength: FindingStrengthSchema,
  effect: FindingEffectSchema,
  source: z.string().min(1),
  message: z.string().min(1),
  url: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({})
});

export type Finding = z.infer<typeof FindingSchema>;
export type FindingStrength = z.infer<typeof FindingStrengthSchema>;
export type FindingEffect = z.infer<typeof FindingEffectSchema>;
