import { z } from 'zod';
import { CommonResultCoreSchema } from './common.js';

export const HuntResultSchema = CommonResultCoreSchema.extend({
  command: z.literal('hunt')
}).passthrough();

export type HuntResult = z.infer<typeof HuntResultSchema>;
