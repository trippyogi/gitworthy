import { z } from 'zod';
import { CommonResultCoreSchema } from './common.js';

export const ScanResultSchema = CommonResultCoreSchema.extend({
  command: z.literal('scan')
}).passthrough();

export type ScanResult = z.infer<typeof ScanResultSchema>;
