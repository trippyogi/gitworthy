import { describe, expect, it } from 'vitest';
import { GENERIC_CONTRIBUTION_PROFILE, extractPlatformHints, matchDomains, parseContributionProfile, platformExecutionFit } from '../src/core/contribution-profile.js';

describe('contribution profile', () => {
  it('uses generic defaults with no Hermes-specific domains', () => {
    const profile = parseContributionProfile();
    expect(profile.domains).toEqual([]);
    expect(profile.mode_weights.BUILD).toBe(1);
    expect(profile.stale_pr_days).toBe(14);
    expect(JSON.stringify(GENERIC_CONTRIBUTION_PROFILE)).not.toMatch(/hermes|bedrock|anthropic/i);
  });

  it('matches domains lexically and returns reasons', () => {
    const profile = parseContributionProfile({
      domains: [{ id: 'runtime-providers', terms: ['fallback', 'provider'], weight: 1.3 }]
    });
    const hit = matchDomains({ title: 'Fix provider fallback on timeout' }, profile);
    expect(hit.matched_domains).toEqual(['runtime-providers']);
    expect(hit.domain_fit_score).toBeGreaterThan(0.5);
    expect(hit.reasons[0]).toMatch(/runtime-providers/);
    expect(matchDomains({ title: 'Unrelated typo' }, profile).matched_domains).toEqual([]);
  });

  it('extracts platform hints from labels and text', () => {
    expect(extractPlatformHints({ title: 'Crash on Windows PowerShell', labels: ['bug'] })).toContain('windows');
    expect(extractPlatformHints({ labels: ['linux'] })).toContain('linux');
    expect(extractPlatformHints({ body: 'repro in docker compose' })).toContain('container');
  });

  it('lowers execution_fit when the required platform is unavailable, not confidence', () => {
    const fit = platformExecutionFit(['windows'], ['linux']);
    expect(fit.execution_fit).toBeLessThan(1);
    expect(fit.unavailable).toEqual(['windows']);
    expect(fit.reasons.join(' ')).toMatch(/execution_fit lowered, confidence unchanged/);
  });
});
