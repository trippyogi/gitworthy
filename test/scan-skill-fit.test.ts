import { beforeEach, describe, expect, it, vi } from 'vitest';

const ISSUE_BODY = 'This adds first-class support and documentation for the widget subsystem, covering configuration, defaults, and a short usage example for downstream consumers.';

const BASE_ISSUES = [
  { number: 1, title: 'Add swift support for the widget subsystem', body: ISSUE_BODY, state: 'open', labels: [], comments: 2, html_url: 'https://github.com/o/r/issues/1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-05T00:00:00Z', closed_at: null },
  { number: 2, title: 'Add typescript support for the widget subsystem', body: ISSUE_BODY, state: 'open', labels: [], comments: 2, html_url: 'https://github.com/o/r/issues/2', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-05T00:00:00Z', closed_at: null }
];

function defaultGithubJson(path: string): unknown {
  if (path.startsWith('/repos/o/r/issues?')) return BASE_ISSUES;
  if (path === '/repos/o/r') return { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r', language: null, topics: [], description: null };
  if (path.startsWith('/search/issues')) return { items: [] };
  return [];
}

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(async (path: string) => defaultGithubJson(path)),
  readCache: vi.fn(async () => ({ hit: false }))
}));

vi.mock('../src/lib/github.js', () => ({ githubJson: mocks.githubJson }));
vi.mock('../src/lib/cache.js', () => ({ readCache: mocks.readCache }));

const { scan } = await import('../src/core/scan.js');

beforeEach(() => {
  mocks.githubJson.mockReset();
  mocks.githubJson.mockImplementation(async (path: string) => defaultGithubJson(path));
  mocks.readCache.mockReset();
  mocks.readCache.mockImplementation(async () => ({ hit: false }));
});

function candidatesOf(evidence: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return evidence.filter((item) => !('kind' in item));
}

describe('scan with skill_profile', () => {
  it('ties in quality_score without a skill_profile', async () => {
    const result = await scan({ repo: 'o/r', limit: 10, land_hints: false });
    const candidates = candidatesOf(result.evidence);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].quality_score).toBe(candidates[1].quality_score);
    expect(candidates[0]).not.toHaveProperty('fit_score');
    expect(result.checked).toContain('no skill_profile provided; fit_score not computed');
  });

  it('boosts a TypeScript issue above a same-quality Swift issue when the profile favors typescript', async () => {
    const result = await scan({ repo: 'o/r', limit: 10, land_hints: false, skill_profile: { languages: ['typescript'] } });
    const candidates = candidatesOf(result.evidence);
    expect(candidates[0]).toMatchObject({ number: 2 });
    expect(candidates[1]).toMatchObject({ number: 1 });
    expect(Number(candidates[0].fit_score)).toBeGreaterThan(Number(candidates[1].fit_score));
    expect(result.checked.some((item) => item.includes('skill_profile provided: computed fit_score for 2 candidates'))).toBe(true);
    expect(result.checked.some((item) => item.includes('ranking_version=1'))).toBe(true);
  });

  it('accepts a raw skill_profile string in the same key=value form as the CLI', async () => {
    const result = await scan({ repo: 'o/r', limit: 10, land_hints: false, skill_profile: 'languages=typescript' });
    const candidates = candidatesOf(result.evidence);
    expect(candidates[0]).toMatchObject({ number: 2 });
  });

  it('reports that skill_profile was provided but unparseable, instead of claiming none was provided', async () => {
    const result = await scan({ repo: 'o/r', limit: 10, land_hints: false, skill_profile: 'not-a-valid-profile' });
    const candidates = candidatesOf(result.evidence);
    expect(candidates[0]).not.toHaveProperty('fit_score');
    expect(result.checked).toContain('skill_profile provided but could not be parsed into any recognized languages/topics/avoid terms; fit_score not computed');
    expect(result.checked).not.toContain('no skill_profile provided; fit_score not computed');
  });

  it('penalizes avoid terms so a matching issue ranks below a neutral one', async () => {
    const result = await scan({ repo: 'o/r', limit: 10, land_hints: false, skill_profile: { avoid: ['swift'] } });
    const candidates = candidatesOf(result.evidence);
    expect(candidates[0]).toMatchObject({ number: 2 });
    expect(candidates[1]).toMatchObject({ number: 1 });
    expect(Number(candidates[1].fit_score)).toBeLessThan(0.5);
  });
});
