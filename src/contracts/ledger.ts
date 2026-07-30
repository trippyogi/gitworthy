import { z } from 'zod';
import { CommonResultCoreSchema } from './common.js';

export const LedgerResultSchema = CommonResultCoreSchema.extend({
  command: z.enum(['ledger_list', 'ledger_show', 'ledger_record', 'ledger_lookup'])
}).passthrough();

export type LedgerResult = z.infer<typeof LedgerResultSchema>;
