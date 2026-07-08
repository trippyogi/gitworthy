import { z } from 'zod';

export const EvidenceSchema = z.record(z.string(), z.unknown()).and(z.object({ url: z.string().optional(), ref: z.string().optional() }));
export const SignalSchema = z.enum(['in_flight', 'shipped', 'released_fix', 'duplicate']);

export const EnvelopeSchema = z.object({
  verdict_summary: z.string().min(1),
  evidence: z.array(EvidenceSchema),
  signals: z.array(SignalSchema),
  checked: z.array(z.string()).min(1),
  not_checked: z.array(z.string()).min(1),
  cached: z.boolean(),
  fetched_at: z.string().datetime()
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Signal = z.infer<typeof SignalSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function createEnvelope(input: Omit<Envelope, 'cached' | 'fetched_at' | 'signals'> & Partial<Pick<Envelope, 'cached' | 'fetched_at' | 'signals'>>): Envelope {
  return EnvelopeSchema.parse({
    ...input,
    signals: input.signals ?? [],
    cached: input.cached ?? false,
    fetched_at: input.fetched_at ?? nowIso()
  });
}

export class GitworthyError extends Error {
  readonly code: string;
  readonly checked: string[];
  readonly not_checked: string[];
  readonly status?: number;

  constructor(input: { code: string; message: string; checked?: string[]; not_checked?: string[]; status?: number }) {
    super(input.message);
    this.name = 'GitworthyError';
    this.code = input.code;
    this.checked = input.checked ?? [];
    this.not_checked = input.not_checked ?? [input.message];
    this.status = input.status;
  }
}
