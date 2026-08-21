import { describe, expect, it } from 'vitest';
import { effortFactor, scoreModes, scoreOpportunity } from '../src/core/opportunity-score.js';
import { parseContributionProfile } from '../src/core/contribution-profile.js';

const base = {
  impact: 0.8,
  fit: 0.7,
  evidenceability: 0.9,
  availability: 0.8,
  domain_value: 0.6,
  effort_bucket: 'medium' as const
};

describe('opportunity score', () => {
  it('uses the documented benefit and effort formula', () => {
    const scored = scoreOpportunity({ ...base, mode: 'REVIEW' });
    const benefit = 0.30 * 0.8 + 0.20 * 0.7 + 0.20 * 0.9 + 0.15 * 0.8 + 0.15 * 0.6;
    expect(scored.benefit).toBeCloseTo(benefit, 8);
    expect(scored.effort_factor).toBeCloseTo(effortFactor('medium'), 8);
    expect(scored.score).toBeCloseTo(benefit / effortFactor('medium'), 8);
  });

  it('forces BUILD=0 under hard constraints instead of applying a penalty', () => {
    const open = scoreOpportunity({ ...base, mode: 'BUILD' });
    const blocked = scoreOpportunity({
      ...base,
      mode: 'BUILD',
      hard_constraints: ['suppress_build']
    });
    expect(open.score).toBeGreaterThan(0);
    expect(blocked.score).toBe(0);
    expect(blocked.reasons).toContain('hard constraint forces BUILD=0');
  });

  it('keeps unknown effort in the unknown bucket', () => {
    const scored = scoreOpportunity({ ...base, mode: 'BUILD', effort_bucket: 'unknown' });
    expect(scored.effort_bucket).toBe('unknown');
    expect(scored.effort_factor).toBe(1);
    expect(scored.reasons.join(' ')).toMatch(/unknown effort/);
  });

  it('does not replace hunt rank: mode scores are separate and weighted', () => {
    const profile = parseContributionProfile({ mode_weights: { REVIEW: 1.2, BUILD: 0.4 } });
    const scores = scoreModes({ ...base, profile });
    expect(scores.REVIEW.score).toBeGreaterThan(scores.BUILD.score);
    expect(scores.WATCH.score).toBeLessThan(scores.REVIEW.score);
  });

  it('raises REPRODUCE when a required platform is available', () => {
    const profile = parseContributionProfile({ platforms: ['windows'] });
    const withPlatform = scoreOpportunity({
      ...base,
      mode: 'REPRODUCE',
      required_platforms: ['windows'],
      profile
    });
    const without = scoreOpportunity({ ...base, mode: 'REPRODUCE', profile });
    expect(withPlatform.score).toBeGreaterThan(without.score);
    expect(withPlatform.execution_fit).toBe(1);
  });
});
