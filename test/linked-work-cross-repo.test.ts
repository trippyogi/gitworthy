import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(async (path: string) => {
    if (path === '/repos/o/r') return { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
    if (path.includes('/issues/1001/timeline')) return [
      {
        event: 'cross-referenced',
        created_at: '2026-07-09T00:00:00Z',
        source: {
          type: 'issue',
          issue: { number: 55, pull_request: { url: 'https://api.github.com/repos/o/other-repo/pulls/55', html_url: 'https://github.com/o/other-repo/pull/55' } }
        }
      }
    ];
    if (path.includes('/issues/1001/comments')) return [];
    if (path.includes('/repos/o/other-repo/pulls/55')) return {
      number: 55,
      state: 'open',
      draft: false,
      merged: false,
      title: 'Fix from fork',
      html_url: 'https://github.com/o/other-repo/pull/55',
      user: { login: 'forkdev' },
      created_at: '2026-07-08T00:00:00Z',
      updated_at: '2026-07-09T00:00:00Z',
      closed_at: null,
      merged_at: null
    };
    if (path.includes('/repos/o/r/pulls/55')) {
      throw new Error('wrong-repo lookup: timeline event pointed to o/other-repo#55, not o/r#55');
    }
    if (path.includes('/issues/1001')) return {
      number: 1001,
      title: 'Cross repo issue',
      body: null,
      state: 'open',
      labels: [],
      assignees: [],
      comments: 0,
      html_url: 'https://github.com/o/r/issues/1001',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-09T00:00:00Z',
      closed_at: null
    };
    if (path.includes('/search/issues')) return { items: [] };
    return { items: [] };
  })
}));

vi.mock('../src/lib/github.js', () => ({ githubJson: mocks.githubJson }));

const { linked_work } = await import('../src/core/linked-work.js');

describe('linked_work cross-repo identity', () => {
  it('resolves a cross-referenced timeline PR to its own repo instead of the home repo', async () => {
    const result = await linked_work({ repo: 'o/r', issue_number: 1001 });
    expect(result.evidence).toContainEqual(expect.objectContaining({
      kind: 'linked_pr',
      number: 55,
      repo: 'o/other-repo',
      author: 'forkdev',
      source: 'timeline',
      title: 'Fix from fork'
    }));
    expect(result.signals).toContain('linked_pr_open');
  });

  it('does not merge PR #N in the home repo with PR #N in a different repo (number collision)', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path === '/repos/o/r') return { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
      if (path.includes('/issues/1002/timeline')) return [
        {
          event: 'cross-referenced',
          created_at: '2026-07-09T00:00:00Z',
          source: { type: 'issue', issue: { number: 77, pull_request: { url: 'https://api.github.com/repos/o/fork/pulls/77' } } }
        }
      ];
      if (path.includes('/issues/1002/comments')) return [
        {
          body: 'See https://github.com/o/r/pull/77 for the home-repo attempt',
          created_at: '2026-07-08T00:00:00Z',
          user: { login: 'dev' },
          html_url: 'https://github.com/o/r/issues/1002#issuecomment-1'
        }
      ];
      if (path.includes('/repos/o/fork/pulls/77')) return {
        number: 77,
        state: 'open',
        draft: false,
        merged: false,
        title: 'Fork fix attempt',
        html_url: 'https://github.com/o/fork/pull/77',
        user: { login: 'forkdev' },
        created_at: '2026-07-08T00:00:00Z',
        updated_at: '2026-07-09T00:00:00Z',
        closed_at: null,
        merged_at: null
      };
      if (path.includes('/repos/o/r/pulls/77')) return {
        number: 77,
        state: 'closed',
        draft: false,
        merged: false,
        title: 'Home repo fix attempt',
        html_url: 'https://github.com/o/r/pull/77',
        user: { login: 'homedev' },
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-02T00:00:00Z',
        closed_at: '2026-07-02T00:00:00Z',
        merged_at: null
      };
      if (path.includes('/issues/1002')) return {
        number: 1002,
        title: 'Collision issue',
        body: null,
        state: 'open',
        labels: [],
        assignees: [],
        comments: 1,
        html_url: 'https://github.com/o/r/issues/1002',
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-09T00:00:00Z',
        closed_at: null
      };
      if (path.includes('/search/issues')) return { items: [] };
      return { items: [] };
    });
    const result = await linked_work({ repo: 'o/r', issue_number: 1002 });
    const prs = result.evidence.filter((item) => item.kind === 'linked_pr');
    expect(prs).toHaveLength(2);
    expect(prs).toContainEqual(expect.objectContaining({ number: 77, repo: 'o/fork', source: 'timeline', title: 'Fork fix attempt' }));
    expect(prs).toContainEqual(expect.objectContaining({ number: 77, repo: 'o/r', source: 'comment', title: 'Home repo fix attempt' }));
    // Both signals reflect the two distinct PRs (one open in the fork, one closed unmerged at home).
    expect(result.signals).toContain('linked_pr_open');
    expect(result.signals).toContain('linked_pr_closed');
  });

  it('resolves a comment-referenced cross-repo pull request URL to the correct repo', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path === '/repos/o/r') return { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
      if (path.includes('/issues/1003/timeline')) return [];
      if (path.includes('/issues/1003/comments')) return [
        {
          body: 'I opened a PR against the fork instead: https://github.com/o/sibling-repo/pull/909',
          created_at: '2026-07-09T00:00:00Z',
          user: { login: 'dev4' },
          html_url: 'https://github.com/o/r/issues/1003#issuecomment-1'
        }
      ];
      if (path.includes('/repos/o/sibling-repo/pulls/909')) return {
        number: 909,
        state: 'open',
        draft: false,
        merged: false,
        title: 'Sibling repo fix',
        html_url: 'https://github.com/o/sibling-repo/pull/909',
        user: { login: 'dev4' },
        created_at: '2026-07-08T00:00:00Z',
        updated_at: '2026-07-09T00:00:00Z',
        closed_at: null,
        merged_at: null
      };
      if (path.includes('/repos/o/r/pulls/909')) {
        throw new Error('wrong-repo lookup: comment URL pointed to o/sibling-repo#909, not o/r#909');
      }
      if (path.includes('/issues/1003')) return {
        number: 1003,
        title: 'Sibling repo issue',
        body: null,
        state: 'open',
        labels: [],
        assignees: [],
        comments: 1,
        html_url: 'https://github.com/o/r/issues/1003',
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-09T00:00:00Z',
        closed_at: null
      };
      if (path.includes('/search/issues')) return { items: [] };
      return { items: [] };
    });
    const result = await linked_work({ repo: 'o/r', issue_number: 1003 });
    expect(result.evidence).toContainEqual(expect.objectContaining({
      kind: 'linked_pr',
      number: 909,
      repo: 'o/sibling-repo',
      source: 'comment',
      title: 'Sibling repo fix'
    }));
    expect(result.signals).toContain('linked_pr_open');
  });

  it('dedupes the same PR when input repo is an alias of the canonical name', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path === '/repos/legacy/old') {
        return { full_name: 'canon/new', default_branch: 'main', html_url: 'https://github.com/canon/new' };
      }
      if (path.includes('/issues/1004/timeline')) {
        return [
          {
            event: 'cross-referenced',
            created_at: '2026-07-09T00:00:00Z',
            source: {
              type: 'issue',
              issue: {
                number: 42,
                pull_request: {
                  url: 'https://api.github.com/repos/canon/new/pulls/42',
                  html_url: 'https://github.com/canon/new/pull/42'
                }
              }
            }
          }
        ];
      }
      if (path.includes('/issues/1004/comments')) return [];
      if (path.includes('/repos/canon/new/pulls/42')) {
        return {
          number: 42,
          state: 'open',
          draft: false,
          merged: false,
          title: 'Closes #1004',
          body: 'Closes #1004',
          html_url: 'https://github.com/canon/new/pull/42',
          user: { login: 'dev5' },
          created_at: '2026-07-08T00:00:00Z',
          updated_at: '2026-07-09T00:00:00Z',
          closed_at: null,
          merged_at: null
        };
      }
      if (path.includes('/repos/legacy/old/pulls/42')) {
        throw new Error('alias input must not be used as PR identity/fetch once canonical is known');
      }
      if (path.includes('/issues/1004')) {
        return {
          number: 1004,
          title: 'Alias repo issue',
          body: null,
          state: 'open',
          labels: [],
          assignees: [],
          comments: 0,
          html_url: 'https://github.com/legacy/old/issues/1004',
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-09T00:00:00Z',
          closed_at: null
        };
      }
      if (path.includes('/search/issues')) {
        return {
          items: [
            {
              number: 42,
              title: 'Closes #1004',
              body: 'Closes #1004',
              pull_request: { url: 'https://api.github.com/repos/canon/new/pulls/42', html_url: 'https://github.com/canon/new/pull/42' },
              repository_url: 'https://api.github.com/repos/canon/new',
              html_url: 'https://github.com/canon/new/pull/42'
            }
          ]
        };
      }
      return { items: [] };
    });
    const result = await linked_work({ repo: 'legacy/old', issue_number: 1004 });
    const linked = result.evidence.filter((item) => (item as { kind?: string }).kind === 'linked_pr');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toEqual(expect.objectContaining({
      kind: 'linked_pr',
      number: 42,
      repo: 'canon/new',
      source: 'timeline'
    }));
  });
});
