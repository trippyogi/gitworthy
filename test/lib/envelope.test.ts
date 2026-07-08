import { describe, expect, it } from 'vitest';
import { createEnvelope, EnvelopeSchema } from '../../src/core/envelope.js';

describe('envelope', () => {
  it('requires checked and not_checked entries', () => {
    const envelope = createEnvelope({ verdict_summary: 'ready', evidence: [{ url: 'https://example.com' }], checked: ['one check'], not_checked: ['one limit'] });
    expect(EnvelopeSchema.parse(envelope).not_checked).toEqual(['one limit']);
    expect(() => EnvelopeSchema.parse({ ...envelope, not_checked: [] })).toThrow();
  });
});
