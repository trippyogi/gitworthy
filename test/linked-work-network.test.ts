import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(async (path: string) => {
    // Clean home repo: no timeline events, no comments, no same-repo/title-overlap search hits.
    if (path.includes('/issues/901/timeline')) return [];
    if (path.includes('/issues/901/comments')) return [];
    if (path.includes('/search/issues')) {
      if (path.includes('org%3Ao')) {
        return {
          items: [
            {
              number: 55,
              title: 'Fix network issue',
              body: 'Fixes #901',
              state: 'open',
              labels: [],
              comments: 0,
              html_url: 'https://github.com/o/r-fork/pull/55',
              created_at: '2026-07-08T00:00:00Z',
              updated_at: '2026-07-08T00:00:00Z',
              closed_at: null,
              pull_request: { url: 'https://api.github.com/repos/o/r-fork/pulls/55', html_url: 'https://github.com/o/r-fork/pull/55' }
            }
          ]
        };
      }
      return { items: [] };
    }
    if (path.includes('/repos/o/r-fork/pulls/55')) {
      return {
        number: 55,
        state: 'open',
        draft: false,
        merged: false,
        title: 'Fix network issue',
        body: 'Fixes #901',
        html_url: 'https://github.com/o/r-fork/pull/55',
        user: { login: 'forkdev' },
        created_at: '2026-07-08T00:00:00Z',
        updated_at: '2026-07-08T00:00:00Z',
        closed_at: null,
        merged_at: null
      };
    }
    if (path.includes('/issues/901')) {
      return {
        number: 901,
        title: 'Network issue',
        body: null,
        state: 'open',
        labels: [],
        assignees: [],
        comments: 0,
        html_url: 'https://github.com/o/r/issues/901',
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-09T00:00:00Z',
        closed_at: null
      };
    }
    return { items: [] };
  })
}));

vi.mock('../src/lib/github.js', () => ({ githubJson: mocks.githubJson }));

const { linked_work } = await import('../src/core/linked-work.js');

describe('linked_work network/fork density evidence', () => {
  it('adds network_pr evidence for a fork PR found via org search, without forcing linked_pr_open', async () => {
    const result = await linked_work({ repo: 'o/r', issue_number: 901 });

    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        kind: 'network_pr',
        number: 55,
        repo: 'o/r-fork',
        state: 'open',
        merged: false,
        url: 'https://github.com/o/r-fork/pull/55',
        title: 'Fix network issue',
        author: 'forkdev',
        source: 'org_search'
      })
    );
    // Fork PRs are density evidence only — never sufficient to claim a linked PR or force a signal.
    expect(result.signals).not.toContain('linked_pr_open');
    expect(result.signals).not.toContain('linked_pr_merged');
    expect(result.signals).not.toContain('linked_pr_closed');
    expect(result.evidence.some((item) => item.kind === 'linked_pr')).toBe(false);
    expect(result.verdict_summary).toContain('network/fork PR');
    expect(result.not_checked.join(' ')).toContain('org-scoped');
  });

  it('swallows org search failures into not_checked instead of failing linked_work', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path.includes('/issues/902/timeline')) return [];
      if (path.includes('/issues/902/comments')) return [];
      if (path.includes('/search/issues') && (path.includes('org%3A') || path.includes('user%3A')) && path.includes('%23')) {
        // Network density searches (org: or user: with issue #) fail; other searches stay empty.
        if (path.includes('Fixes') || path.includes('Closes') || path.includes('%23' + '902') || path.includes('%23902')) {
          throw new Error('search unavailable');
        }
        return { items: [] };
      }
      if (path.includes('/search/issues')) return { items: [] };
      if (path.includes('/issues/902')) {
        return {
          number: 902,
          title: 'Another issue',
          body: null,
          state: 'open',
          labels: [],
          assignees: [],
          comments: 0,
          html_url: 'https://github.com/o/r/issues/902',
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-09T00:00:00Z',
          closed_at: null
        };
      }
      return { items: [] };
    });

    const result = await linked_work({ repo: 'o/r', issue_number: 902 });

    expect(result.evidence.some((item) => item.kind === 'network_pr')).toBe(false);
    expect(result.not_checked.join(' ')).toContain('network pull request search');
    expect(result.signals).not.toContain('linked_pr_open');
  });
});
