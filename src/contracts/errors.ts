import { z } from 'zod';
import { SCHEMA_VERSION } from './common.js';

export const ErrorCategorySchema = z.enum(['input', 'auth', 'network', 'provider', 'budget', 'storage', 'internal']);

export const ErrorDetailSchema = z.object({
  code: z.string().min(1),
  category: ErrorCategorySchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  status: z.number().int().nullable().optional(),
  details: z.record(z.string(), z.unknown()).default({})
});

export const ErrorResultSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  gitworthy_version: z.string().min(1),
  ok: z.literal(false),
  command: z.string().min(1),
  run_id: z.string().min(1),
  error: ErrorDetailSchema,
  checked: z.array(z.string()).min(1),
  not_checked: z.array(z.string()).min(1),
  generated_at: z.string().datetime()
});

export type ErrorResult = z.infer<typeof ErrorResultSchema>;
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;
