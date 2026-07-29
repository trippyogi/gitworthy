import { describe, expect, it, vi } from 'vitest';
import { assessIssueQuality, assessRepro, lexicalOverlapScore, looksLikeBug } from '../src/core/candidate-quality.js';
import { isAutomationAuthor } from '../src/core/bots.js';
import { branchMatches } from '../src/core/branch-scan.js';

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(async (path: string) => {
    if (path.includes('/commits/')) {
      return { commit: { author: { date: new Date().toISOString() }, message: 'wip' }, html_url: 'https://github.com/o/r/commit/abc' };
    }
    if (path.includes('/repos/o/r') && !path.includes('/issues') && !path.includes('/pulls') && !path.includes('/search') && !path.includes('/commits')) {
      return { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
    }
    if (path.includes('/issues/900/timeline')) return [
      { event: 'cross-referenced', created_at: '2026-07-09T00:00:00Z', source: { type: 'issue', issue: { number: 901, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/901' } } } }
    ];
    if (path.includes('/issues/900/comments')) return [];
    if (path.includes('/pulls/901')) return {
      number: 901,
      state: 'open',
      draft: false,
      merged: false,
      title: 'Bump lodash from 4.17.20 to 4.17.21',
      body: 'Bumps lodash. Mentions #900 incidentally.',
      html_url: 'https://github.com/o/r/pull/901',
      user: { login: 'dependabot[bot]' },
      created_at: '2026-07-08T00:00:00Z',
      updated_at: '2026-07-09T00:00:00Z',
      closed_at: null,
      merged_at: null
    };
    if (path.includes('/issues/900')) return {
      number: 900,
      title: 'Cart drawer fails on inventory 422',
      body: 'Steps to reproduce:\n1. Add item\nExpected behavior: drawer updates',
      state: 'open',
      labels: [{ name: 'bug' }],
      assignees: [],
      comments: 1,
      html_url: 'https://github.com/o/r/issues/900',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-09T00:00:00Z',
      closed_at: null
    };
    if (path.includes('/issues/910/timeline')) return [];
    if (path.includes('/issues/910/comments')) return [{
      body: "I've submitted a PR for this.",
      created_at: '2026-07-09T00:00:00Z',
      user: { login: 'dev' },
      html_url: 'https://github.com/o/r/issues/910#issuecomment-1'
    }];
    if (path.includes('/issues/910')) return {
      number: 910,
      title: 'Preserve classified agent turn failures',
      body: 'Do not collapse classified failures to Turn error',
      state: 'open',
      labels: [],
      assignees: [],
      comments: 1,
      html_url: 'https://github.com/o/r/issues/910',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-09T00:00:00Z',
      closed_at: null
    };
    if (path.includes('/search/issues') && path.includes('is%3Aopen')) {
      return {
        items: [{
          number: 911,
          title: 'Preserve classified agent turn failures in buzz',
          body: 'Stop collapsing classified agent turn failures',
          state: 'open',
          labels: [],
          comments: 0,
          html_url: 'https://github.com/o/r/pull/911',
          created_at: '2026-07-08T00:00:00Z',
          updated_at: '2026-07-08T00:00:00Z',
          closed_at: null,
          pull_request: { url: 'https://api.github.com/repos/o/r/pulls/911' }
        }]
      };
    }
    if (path.includes('/pulls/911')) return {
      number: 911,
      state: 'open',
      draft: false,
      merged: false,
      title: 'Preserve classified agent turn failures in buzz',
      body: 'Stop collapsing classified agent turn failures',
      html_url: 'https://github.com/o/r/pull/911',
      user: { login: 'dev' },
      created_at: '2026-07-08T00:00:00Z',
      updated_at: '2026-07-08T00:00:00Z',
      closed_at: null,
      merged_at: null
    };
    if (path.includes('/search/issues')) return { items: [] };
    return { items: [] };
  }),
  fetchRaw: vi.fn(async (_repo: string, _branch: string, file: string) => {
    if (file === 'CONTRIBUTING.md') {
      return '# Contributing\n\nPlease request assignment before opening a pull request.\n';
    }
    return null;
  }),
  heads: vi.fn(async () => [
    { name: 'proxy-timeout-tuning', sha: 'abc' },
    { name: 'fix-910-turn-failures', sha: 'def' }
  ])
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: mocks.githubJson,
  fetchRaw: mocks.fetchRaw
}));
vi.mock('../src/lib/git.js', () => ({
  lsRemoteHeads: mocks.heads,
  shallowClone: vi.fn(async () => ({ dir: process.cwd(), cleanup: async () => undefined }))
}));
vi.mock('../src/lib/cache.js', () => ({
  readCache: vi.fn(async () => ({ hit: false })),
  writeCache: vi.fn(async () => undefined),
  deleteCache: vi.fn(async () => undefined)
}));

const { linked_work } = await import('../src/core/linked-work.js');
const { contrib_policy } = await import('../src/core/contrib-policy.js');
const { branch_scan } = await import('../src/core/branch-scan.js');
const { scan } = await import('../src/core/scan.js');

describe('candidate quality helpers', () => {
  it('detects automation authors', () => {
    expect(isAutomationAuthor('dependabot[bot]')).toBe(true);
    expect(isAutomationAuthor('renovate[bot]')).toBe(true);
    expect(isAutomationAuthor('human-dev')).toBe(false);
  });

  it('scores reproducible bugs above soft asks', () => {
    const strong = assessIssueQuality({
      title: 'Cart drawer fails on inventory 422',
      body: 'Steps to reproduce:\n1. Add item\nExpected behavior: refresh\nActual behavior: stale',
      labels: ['bug', 'good first issue'],
      assignees: [],
      comments: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    const soft = assessIssueQuality({
      title: 'Would be nice to add an SDK skill',
      body: 'Consider adding docs',
      labels: ['enhancement'],
      assignees: ['someone'],
      comments: 0,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z'
    });
    expect(strong.repro).toBe('present');
    expect(soft.soft_ask).toBe(true);
    expect(strong.score).toBeGreaterThan(soft.score);
    expect(assessRepro(null)).toBe('missing');
    expect(looksLikeBug({ title: 'Instrument debug logs', body: 'add logging', labels: ['debug'] })).toBe(false);
  });

  it('computes lexical overlap for title linkage', () => {
    const { score, shared } = lexicalOverlapScore(
      'Preserve classified agent turn failures',
      'Preserve classified agent turn failures in buzz'
    );
    expect(shared.length).toBeGreaterThanOrEqual(2);
    expect(score).toBeGreaterThan(0.3);
  });
});

describe('linked_work improvements', () => {
  it('ignores automation-authored linked PRs for verdict signals', async () => {
    const result = await linked_work({ repo: 'o/r', issue_number: 900 });
    expect(result.signals).not.toContain('linked_pr_open');
    expect(result.evidence).toContainEqual(expect.objectContaining({
      kind: 'linked_pr',
      number: 901,
      ignored_reason: 'automation_author'
    }));
    expect(result.checked.join(' ')).toContain('automation-authored');
  });

  it('links high title-overlap open PRs when a claim comment lacks a URL', async () => {
    const result = await linked_work({ repo: 'o/r', issue_number: 910 });
    expect(result.signals).toContain('linked_pr_open');
    expect(result.evidence).toContainEqual(expect.objectContaining({
      kind: 'linked_pr',
      number: 911,
      source: 'title_overlap'
    }));
  });
});

describe('branch_scan precision', () => {
  it('rejects broad single-token matches like proxy', () => {
    expect(branchMatches('proxy-timeout-tuning', ['proxy'])).toBe(false);
    expect(branchMatches('recover-sleep-interrupted-turns', ['sleep'])).toBe(true);
    expect(branchMatches('fix-910-turn-failures', ['turn'], 910)).toBe(true);
    expect(branchMatches('release/1.2.3', ['zzzz'], 1)).toBe(false);
    expect(branchMatches('v2.0.0', ['zzzz'], 2)).toBe(false);
  });

  it('matches issue-number branches even without keyword overlap', async () => {
    const result = await branch_scan({ repo: 'o/r', keywords: ['zzzz'], issue_number: 910, force_refresh: true });
    expect(result.evidence).toContainEqual(expect.objectContaining({ branch: 'fix-910-turn-failures', match_reason: 'issue_number' }));
    expect(result.signals).toEqual(['in_flight']);
  });
});

describe('contrib_policy claim_required', () => {
  it('emits claim_required when docs require assignment first', async () => {
    const result = await contrib_policy({ repo: 'o/r', force_refresh: true });
    expect(result.signals).toContain('claim_required');
    expect(result.evidence).toContainEqual(expect.objectContaining({ category: 'claim_required' }));
  });
});

describe('scan quality ranking', () => {
  it('ranks clearer bugs above soft assigned asks', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path.includes('/commits/')) {
        return { commit: { author: { date: new Date().toISOString() }, message: 'wip' }, html_url: 'https://github.com/o/r/commit/abc' };
      }
      if (path.includes('/issues?')) {
        return [
          {
            number: 1,
            title: 'Would be nice to add an SDK skill',
            body: 'Consider adding',
            state: 'open',
            labels: [{ name: 'enhancement' }],
            assignees: [{ login: 'owner' }],
            comments: 0,
            html_url: 'https://github.com/o/r/issues/1',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2026-07-10T00:00:00Z',
            closed_at: null
          },
          {
            number: 2,
            title: 'Auth token refresh fails intermittently',
            body: 'Steps to reproduce:\n1. Login\nExpected behavior: refresh succeeds\nActual behavior: 401 loop',
            state: 'open',
            labels: [{ name: 'bug' }, { name: 'good first issue' }],
            assignees: [],
            comments: 3,
            html_url: 'https://github.com/o/r/issues/2',
            created_at: '2026-07-01T00:00:00Z',
            updated_at: '2026-07-09T00:00:00Z',
            closed_at: null
          }
        ];
      }
      return { items: [] };
    });
    const result = await scan({ repo: 'o/r', limit: 10 });
    expect(result.evidence[0]).toMatchObject({ number: 2 });
    expect((result.evidence[0] as { quality_score: number }).quality_score)
      .toBeGreaterThan((result.evidence[1] as { quality_score: number }).quality_score);
  });
});
