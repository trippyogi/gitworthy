import { beforeEach, describe, expect, it, vi } from 'vitest';

type Repo = { full_name: string; archived?: boolean; fork?: boolean; stargazers_count?: number; pushed_at?: string; updated_at?: string };

const REPOS: Repo[] = [
  { full_name: 'acme/alpha', stargazers_count: 100, pushed_at: '2026-01-10T00:00:00Z' },
  { full_name: 'acme/beta', stargazers_count: 50, pushed_at: '2026-01-09T00:00:00Z' },
  { full_name: 'acme/epsilon', stargazers_count: 30, pushed_at: '2026-01-08T00:00:00Z' },
  { full_name: 'acme/zeta', stargazers_count: 10, pushed_at: '2026-01-07T00:00:00Z' },
  { full_name: 'acme/gamma-archived', stargazers_count: 500, archived: true, pushed_at: '2026-01-11T00:00:00Z' },
  { full_name: 'acme/delta-fork', stargazers_count: 400, fork: true, pushed_at: '2026-01-11T00:00:00Z' }
];

function issuesFor(repo: string): unknown[] {
  if (repo === 'acme/alpha') return [
    { number: 1, title: 'Fix alpha bug', body: 'steps to reproduce: do a thing', state: 'open', labels: [{ name: 'bug' }], comments: 1, html_url: `https://github.com/${repo}/issues/1`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-05T00:00:00Z', closed_at: null }
  ];
  if (repo === 'acme/beta') return [
    { number: 2, title: 'Improve beta docs', body: null, state: 'open', labels: [], comments: 0, html_url: `https://github.com/${repo}/issues/2`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', closed_at: null }
  ];
  if (repo === 'acme/epsilon') return [
    { number: 3, title: 'Improve epsilon docs', body: null, state: 'open', labels: [], comments: 0, html_url: `https://github.com/${repo}/issues/3`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', closed_at: null }
  ];
  if (repo === 'acme/zeta') return [
    { number: 4, title: 'Improve zeta docs', body: null, state: 'open', labels: [], comments: 0, html_url: `https://github.com/${repo}/issues/4`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', closed_at: null }
  ];
  return [];
}

function defaultGithubJson(path: string): unknown {
  if (path.startsWith('/orgs/acme/repos')) return REPOS;
  const issuesMatch = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\?/);
  if (issuesMatch) return issuesFor(issuesMatch[1]);
  const repoMatch = path.match(/^\/repos\/([^/]+\/[^/]+)$/);
  if (repoMatch) return { full_name: repoMatch[1], default_branch: 'main', html_url: `https://github.com/${repoMatch[1]}` };
  if (path.startsWith('/search/issues')) return { items: [] };
  return [];
}

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(async (path: string) => defaultGithubJson(path)),
  readCache: vi.fn(async () => ({ hit: false }))
}));

vi.mock('../src/lib/github.js', () => ({ githubJson: mocks.githubJson }));
vi.mock('../src/lib/cache.js', () => ({ readCache: mocks.readCache }));

const { org_scan } = await import('../src/core/org-scan.js');
const { GitworthyError } = await import('../src/core/envelope.js');

beforeEach(() => {
  mocks.githubJson.mockReset();
  mocks.githubJson.mockImplementation(async (path: string) => defaultGithubJson(path));
  mocks.readCache.mockReset();
  mocks.readCache.mockImplementation(async () => ({ hit: false }));
});

describe('org_scan', () => {
  it('lists candidates across top-ranked public repos, excluding archived and forked repos', async () => {
    const result = await org_scan({ org: 'acme', land_hints: false });
    expect(result.evidence.length).toBeGreaterThan(0);
    const repoNames = new Set(result.evidence.map((item) => item.repo));
    expect([...repoNames].every((name) => name !== 'acme/gamma-archived' && name !== 'acme/delta-fork')).toBe(true);
    expect(result.checked).toContain('excluded archived and forked repositories');
    expect(result.verdict_summary).toContain('acme');
    expect(result.not_checked.some((item) => item.includes('does not replace per-repo contrib_policy'))).toBe(true);
  });

  it('limits scanned repos to max_repos, ranked by stargazers_count', async () => {
    const result = await org_scan({ org: 'acme', land_hints: false, max_repos: 2 });
    expect(result.checked.some((item) => item.includes('selected top 2 repositories (max_repos=2)'))).toBe(true);
    expect(result.checked.some((item) => item.startsWith('scanned: acme/alpha, acme/beta'))).toBe(true);
    const repoNames = new Set(result.evidence.map((item) => item.repo));
    expect(repoNames.has('acme/epsilon')).toBe(false);
    expect(repoNames.has('acme/zeta')).toBe(false);
  });

  it('falls back to the user repos endpoint when the org endpoint 404s', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/orgs/solouser/repos')) {
        throw new GitworthyError({ code: 'github_api_error', message: 'Not Found', status: 404 });
      }
      if (path.startsWith('/users/solouser/repos')) return [{ full_name: 'solouser/proj', stargazers_count: 10, pushed_at: '2026-01-01T00:00:00Z' }];
      return defaultGithubJson(path);
    });
    const result = await org_scan({ org: 'solouser', land_hints: false });
    expect(result.checked.some((item) => item.includes('via user endpoint'))).toBe(true);
    expect(result.not_checked.some((item) => item.includes('retried as a user account'))).toBe(true);
  });

  it('records a not_checked note when a repo scan fails without failing org_scan', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (/^\/repos\/acme\/alpha\/issues\?/.test(path)) throw new Error('boom');
      return defaultGithubJson(path);
    });
    const result = await org_scan({ org: 'acme', land_hints: false, max_repos: 2 });
    expect(result.not_checked.some((item) => item.includes('scan failed for 1 repository') && item.includes('acme/alpha') && item.includes('boom'))).toBe(true);
    expect(result.evidence.some((item) => item.repo === 'acme/beta')).toBe(true);
    expect(result.evidence.some((item) => item.repo === 'acme/alpha')).toBe(false);
  });

  it('propagates land_hints to per-repo scans by default', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (/^\/repos\/acme\/alpha\/issues\?/.test(path)) return [
        { number: 5, title: 'Assigned alpha issue', body: null, state: 'open', labels: [], assignees: [{ login: 'dev1' }], comments: 0, html_url: 'https://github.com/acme/alpha/issues/5', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', closed_at: null }
      ];
      return defaultGithubJson(path);
    });
    const result = await org_scan({ org: 'acme', max_repos: 1 });
    const candidate = result.evidence.find((item) => item.number === 5);
    expect(candidate).toMatchObject({ likely_land_only: true, land_hint: 'assigned: dev1', repo: 'acme/alpha' });
  });

  it('sorts merged candidates by quality_score and slices to limit', async () => {
    const result = await org_scan({ org: 'acme', land_hints: false, limit: 1 });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ number: 1, repo: 'acme/alpha' });
  });
});
