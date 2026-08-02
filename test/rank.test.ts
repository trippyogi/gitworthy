import { describe, expect, it } from 'vitest';
import { compareRanked, explainRankingLines, normalizeWeights, rankCandidate } from '../src/core/rank.js';

describe('rankCandidate', () => {
  it('computes a deterministic rank_score from components', () => {
    const components = rankCandidate({
      number: 10,
      quality_score: 80,
      quality_reasons: ['repro'],
      fit_score: 0.8,
      assignees: [],
      soft_ask: false,
      updated_at: '2026-01-02T00:00:00Z'
    });
    expect(components.ranking_version).toBe('1');
    expect(components.rank_score).toBeCloseTo(0.8 * 0.55 + 0.8 * 0.25 + 1 * 0.2, 5);
    expect(explainRankingLines({
      number: 10,
      quality_score: 80,
      quality_reasons: [],
      assignees: [],
      soft_ask: false,
      updated_at: '2026-01-02T00:00:00Z'
    }, components)[0]).toContain('#10 rank_score=');
  });

  it('absorbs fit weight into quality when fit is missing', () => {
    const components = rankCandidate({
      number: 1,
      quality_score: 100,
      quality_reasons: [],
      assignees: [],
      soft_ask: false,
      updated_at: '2026-01-02T00:00:00Z'
    });
    expect(components.fit_score).toBeNull();
    expect(components.not_applicable).toContain('fit_score');
    expect(components.weights.fit).toBe(0);
    expect(components.rank_score).toBeCloseTo(1 * 0.8 + 1 * 0.2, 5);
  });

  it('penalizes assigned / land-only / soft-ask availability', () => {
    const open = rankCandidate({
      number: 1,
      quality_score: 50,
      quality_reasons: [],
      assignees: [],
      soft_ask: false,
      updated_at: '2026-01-02T00:00:00Z'
    });
    const assigned = rankCandidate({
      number: 2,
      quality_score: 50,
      quality_reasons: [],
      assignees: ['alice'],
      likely_land_only: true,
      soft_ask: true,
      updated_at: '2026-01-03T00:00:00Z'
    });
    expect(assigned.availability_hint_score).toBeLessThan(open.availability_hint_score);
    expect(compareRanked(
      { ...open, number: 1, updated_at: '2026-01-02T00:00:00Z' },
      { ...assigned, number: 2, updated_at: '2026-01-03T00:00:00Z' }
    )).toBeLessThan(0);
  });

  it('normalizes custom weights (clamped to 0..1 before renormalizing)', () => {
    expect(normalizeWeights({ quality: 0.4, fit: 0.4, availability: 0.2 })).toEqual({
      quality: 0.4,
      fit: 0.4,
      availability: 0.2
    });
    // Values above 1 are clamped first, so 2/2/1 becomes 1/1/1 → equal thirds.
    expect(normalizeWeights({ quality: 2, fit: 2, availability: 1 })).toEqual({
      quality: 1 / 3,
      fit: 1 / 3,
      availability: 1 / 3
    });
  });
});
