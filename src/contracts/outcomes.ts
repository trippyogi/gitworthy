import { z } from 'zod';

/** Outcome event schema reserved for 0.5.0 storage; defined early for contract stability. */
export const OutcomeEventNameSchema = z.enum([
  'shortlisted',
  'selected',
  'claim_requested',
  'claimed',
  'repro_confirmed',
  'repro_failed',
  'patch_started',
  'comment_posted',
  'pr_opened',
  'merged',
  'closed_unmerged',
  'rejected',
  'abandoned',
  'duplicate_confirmed',
  'already_fixed_confirmed',
  'maintainer_redirected'
]);

export const OutcomeEventSchema = z.object({
  event_version: z.literal(1),
  event_id: z.string().min(1),
  decision_id: z.string().min(1),
  run_id: z.string().min(1),
  target: z.object({
    repo: z.string().min(1),
    issue_number: z.number().int().positive()
  }),
  event: OutcomeEventNameSchema,
  occurred_at: z.string().datetime(),
  source: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().default('')
});

export type OutcomeEvent = z.infer<typeof OutcomeEventSchema>;
