import { z } from 'zod';
import { CommonResultCoreSchema } from './common.js';

export const DoctorResultSchema = CommonResultCoreSchema.extend({
  command: z.literal('doctor')
}).passthrough();

export type DoctorResult = z.infer<typeof DoctorResultSchema>;
