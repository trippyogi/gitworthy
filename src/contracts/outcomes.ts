import { z } from 'zod';

/** Outcome event schema for the local durable store (Track O T1 labels map onto these events). */
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

/**
 * Discriminator for `closed_unmerged` (Track O).
 * Prefer this over a derived enum so Track O labels cannot drift from the store.
 * Optional on read for legacy rows; required on write when event is `closed_unmerged`.
 */
export const CloseReasonSchema = z.enum(['superseded', 'stale', 'withdrawn']);

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
  notes: z.string().default(''),
  /** Required when writing `closed_unmerged`; legacy rows may omit it. */
  close_reason: CloseReasonSchema.optional(),
  /** True when the contribution proceeded despite a soft SKIP (Track O anti-SKIP policy). */
  acted_against_skip: z.boolean().optional(),
  /** PR URL once known; join key companion to decision_id. */
  pr_url: z.string().url().optional()
}).strict().superRefine((value, ctx) => {
  if (value.close_reason !== undefined && value.event !== 'closed_unmerged') {
    ctx.addIssue({
      code: 'custom',
      path: ['close_reason'],
      message: 'close_reason is only valid when event is closed_unmerged'
    });
  }
});

export type OutcomeEvent = z.infer<typeof OutcomeEventSchema>;
export type CloseReason = z.infer<typeof CloseReasonSchema>;
export type OutcomeEventName = z.infer<typeof OutcomeEventNameSchema>;

/** Enforce write-time rules (legacy reads stay lenient). */
export function assertOutcomeWrite(event: OutcomeEvent): void {
  if (event.event === 'closed_unmerged' && event.close_reason === undefined) {
    throw new Error('closed_unmerged requires --close-reason superseded|stale|withdrawn');
  }
}
