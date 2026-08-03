import { describe, expect, it } from 'vitest';
import { IssueNumberSchema, OrgOrUserLoginSchema, RepoRefSchema } from '../src/contracts/index.js';

/** Seeded deterministic fuzz for public input schemas (GW-036). No external fuzzer dependency. */

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rand: () => number, maxLen: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_-.@:;$`()\\ \n\0';
  const len = Math.floor(rand() * maxLen);
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(rand() * alphabet.length)]!;
  return out;
}

describe('seeded input fuzz', () => {
  it('RepoRefSchema rejects random hostile-ish strings (seed 42, n=500)', () => {
    const rand = mulberry32(42);
    let accepted = 0;
    for (let i = 0; i < 500; i += 1) {
      const value = randomString(rand, 80);
      if (RepoRefSchema.safeParse(value).success) accepted += 1;
    }
    // Legitimate owner/repo shapes are rare in this alphabet mix; keep a tight ceiling.
    expect(accepted).toBeLessThan(40);
  });

  it('OrgOrUserLoginSchema never accepts whitespace or path separators (seed 7, n=300)', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 300; i += 1) {
      const value = randomString(rand, 40);
      if (value.includes(' ') || value.includes('/') || value.includes('\\')) {
        expect(OrgOrUserLoginSchema.safeParse(value).success).toBe(false);
      }
    }
  });

  it('IssueNumberSchema accepts only positive integers', () => {
    expect(IssueNumberSchema.safeParse(1).success).toBe(true);
    expect(IssueNumberSchema.safeParse(0).success).toBe(false);
    expect(IssueNumberSchema.safeParse(-3).success).toBe(false);
    expect(IssueNumberSchema.safeParse(1.5).success).toBe(false);
    expect(IssueNumberSchema.safeParse('12').success).toBe(false);
  });
});
