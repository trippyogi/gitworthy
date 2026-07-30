import { describe, expect, it, vi } from 'vitest';
import { closesIssue, mentionsIssue } from '../src/core/linkage.js';
import { chooseDisposition } from '../src/core/worth-check.js';

describe('linkage helpers', () => {
  it('matches issue numbers in titles including (#N)', () => {
    expect(mentionsIssue('Fix escape handling (#114292)', 114292)).toBe(true);
    expect(mentionsIssue('Fix escape handling', 114292)).toBe(false);
    expect(mentionsIssue('Fixes #114292 in body', 114292)).toBe(true);
    expect(closesIssue('Fixes #114292', 114292)).toBe(true);
    expect(closesIssue('Related to #114292', 114292)).toBe(false);
  });
});

describe('chooseDisposition', () => {
  it('maps open linked PRs to land_only ahead of crowded', () => {
    expect(chooseDisposition({
      verdict: 'SKIP',
      signals: ['linked_pr_open'],
      priorAttempts: 5,
      referencedCommits: 8
    })).toBe('land_only');
  });

  it('maps shipped/duplicate to review', () => {
    expect(chooseDisposition({ verdict: 'SKIP', signals: ['shipped'], priorAttempts: 0, referencedCommits: 0 })).toBe('review');
    expect(chooseDisposition({ verdict: 'SKIP', signals: ['duplicate'], priorAttempts: 0, referencedCommits: 0 })).toBe('review');
  });

  it('maps released_fix to blocked', () => {
    expect(chooseDisposition({ verdict: 'SKIP', signals: ['released_fix'], priorAttempts: 0, referencedCommits: 0 })).toBe('blocked');
  });

  it('maps assignment to claim_first', () => {
    expect(chooseDisposition({ verdict: 'VERIFY', signals: ['assigned'], priorAttempts: 0, referencedCommits: 0 })).toBe('claim_first');
  });

  it('maps dense priors/commits to crowded when no open PR', () => {
    expect(chooseDisposition({ verdict: 'VERIFY', signals: ['linked_pr_closed'], priorAttempts: 2, referencedCommits: 0 })).toBe('crowded');
    expect(chooseDisposition({ verdict: 'VERIFY', signals: [], priorAttempts: 0, referencedCommits: 3 })).toBe('crowded');
  });

  it('maps clean ACT to greenfield', () => {
    expect(chooseDisposition({ verdict: 'ACT', signals: [], priorAttempts: 0, referencedCommits: 0 })).toBe('greenfield');
  });
});

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(async (path: string) => {
    if (path.includes('/commits/')) {
      return { commit: { author: { date: new Date().toISOString() }, message: 'wip' }, html_url: 'https://github.com/o/r/commit/abc' };
    }
    if (path.includes('/repos/o/r') && !path.includes('/issues') && !path.includes('/pulls') && !path.includes('/search')) {
      return { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
    }
    if (path.includes('/issues/114292/timeline')) {
      return [
        { event: 'commented', created_at: '2026-07-01T00:00:00Z' },
        { event: 'referenced', created_at: '2026-07-02T00:00:00Z', commit_id: 'aaa111', commit_url: 'https://github.com/o/r/commit/aaa111', actor: { login: 'dev' } },
        { event: 'referenced', created_at: '2026-07-03T00:00:00Z', commit_id: 'bbb222', commit_url: 'https://github.com/o/r/commit/bbb222', actor: { login: 'dev' } },
        { event: 'referenced', created_at: '2026-07-04T00:00:00Z', commit_id: 'ccc333', commit_url: 'https://github.com/o/r/commit/ccc333', actor: { login: 'dev' } }
      ];
    }
    if (path.includes('/issues/114292/comments')) return [];
    if (path.includes('/issues/114292')) {
      return {
        number: 114292,
        title: 'Escape and newlines break',
        body: 'repro steps',
        state: 'open',
        labels: [],
        assignees: [],
        comments: 0,
        html_url: 'https://github.com/o/r/issues/114292',
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-09T00:00:00Z',
        closed_at: null
      };
    }
    if (path.includes('/search/issues')) {
      return {
        items: [
          {
            number: 114390,
            title: 'Attempted fix (#114292)',
            body: 'no issue number in body',
            state: 'closed',
            labels: [],
            comments: 0,
            html_url: 'https://github.com/o/r/pull/114390',
            created_at: '2026-07-02T00:00:00Z',
            updated_at: '2026-07-03T00:00:00Z',
            closed_at: '2026-07-03T00:00:00Z',
            pull_request: { url: 'https://api.github.com/repos/o/r/pulls/114390' }
          },
          {
            number: 114925,
            title: 'Fix escape and newlines',
            body: 'Fixes #114292',
            state: 'open',
            labels: [],
            comments: 0,
            html_url: 'https://github.com/o/r/pull/114925',
            created_at: '2026-07-05T00:00:00Z',
            updated_at: '2026-07-05T00:00:00Z',
            closed_at: null,
            pull_request: { url: 'https://api.github.com/repos/o/r/pulls/114925' }
          }
        ]
      };
    }
    if (path.includes('/pulls/114390')) {
      return {
        number: 114390,
        state: 'closed',
        draft: false,
        merged: false,
        title: 'Attempted fix (#114292)',
        body: 'no issue number in body',
        html_url: 'https://github.com/o/r/pull/114390',
        user: { login: 'dev' },
        created_at: '2026-07-02T00:00:00Z',
        updated_at: '2026-07-03T00:00:00Z',
        closed_at: '2026-07-03T00:00:00Z',
        merged_at: null
      };
    }
    if (path.includes('/pulls/114925')) {
      return {
        number: 114925,
        state: 'open',
        draft: false,
        merged: false,
        title: 'Fix escape and newlines',
        body: 'Fixes #114292',
        html_url: 'https://github.com/o/r/pull/114925',
        user: { login: 'dev' },
        created_at: '2026-07-05T00:00:00Z',
        updated_at: '2026-07-05T00:00:00Z',
        closed_at: null,
        merged_at: null
      };
    }
    return { items: [] };
  })
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: mocks.githubJson,
  fetchRaw: vi.fn(async () => null)
}));
vi.mock('../src/lib/cache.js', () => ({
  readCache: vi.fn(async () => ({ hit: false })),
  writeCache: vi.fn(async () => undefined),
  deleteCache: vi.fn(async () => undefined)
}));

const { linked_work } = await import('../src/core/linked-work.js');

describe('linked_work 0.3.5 gaps', () => {
  it('keeps title-only issue mentions and surfaces referenced commits + timeline warning', async () => {
    const result = await linked_work({ repo: 'o/r', issue_number: 114292 });
    expect(result.signals).toContain('linked_pr_open');
    expect(result.signals).toContain('linked_pr_closed');
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'linked_pr', number: 114390, source: 'search', prior_attempt: true }));
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'linked_pr', number: 114925, closes_issue: true }));
    expect(result.evidence.filter((item) => item.kind === 'referenced_commit')).toHaveLength(3);
    expect(result.not_checked.join(' ')).toContain('no cross-referenced events');
  });
});
