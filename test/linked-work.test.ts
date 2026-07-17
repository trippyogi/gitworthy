import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(async (path: string) => {
    if (path.includes('/issues/101/timeline')) return [
      { event: 'cross-referenced', created_at: '2026-07-09T00:00:00Z', source: { type: 'issue', issue: { number: 202, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/202' } } } }
    ];
    if (path.includes('/issues/101/comments')) return [];
    if (path.includes('/pulls/202')) return { number: 202, state: 'open', draft: false, merged: false, title: 'Fix linked issue', html_url: 'https://github.com/o/r/pull/202', user: { login: 'dev1' }, created_at: '2026-07-08T00:00:00Z', updated_at: '2026-07-09T00:00:00Z', closed_at: null, merged_at: null };
    if (path.includes('/issues/303/timeline')) return [{ event: 'assigned', created_at: '2026-07-07T00:00:00Z', actor: { login: 'maintainer' }, assignee: { login: 'owner1' } }];
    if (path.includes('/issues/303/comments')) return [];
    if (path.includes('/issues/303')) return { number: 303, title: 'Assigned issue', body: null, state: 'open', labels: [], assignees: [{ login: 'owner1' }], comments: 0, html_url: 'https://github.com/o/r/issues/303', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-07T00:00:00Z', closed_at: null };
    if (path.includes('/issues/404/timeline')) return [];
    if (path.includes('/issues/404/comments')) return [];
    if (path.includes('/search/issues')) return { items: [{ number: 505, title: 'Fallback PR', body: 'Fixes #404', state: 'open', labels: [], comments: 0, html_url: 'https://github.com/o/r/pull/505', created_at: '2026-07-08T00:00:00Z', updated_at: '2026-07-08T00:00:00Z', closed_at: null, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/505' } }] };
    if (path.includes('/pulls/505')) return { number: 505, state: 'open', draft: true, merged: false, title: 'Fallback PR', html_url: 'https://github.com/o/r/pull/505', user: { login: 'dev2' }, created_at: '2026-07-08T00:00:00Z', updated_at: '2026-07-08T00:00:00Z', closed_at: null, merged_at: null };
    if (path.includes('/issues/606/timeline')) return [];
    if (path.includes('/issues/606/comments')) return [{ body: 'I opened a PR at https://github.com/o/r/pull/707', created_at: '2026-07-09T00:00:00Z', user: { login: 'dev3' }, html_url: 'https://github.com/o/r/issues/606#issuecomment-1' }];
    if (path.includes('/pulls/707')) return { number: 707, state: 'closed', draft: false, merged: true, title: 'Comment linked PR', html_url: 'https://github.com/o/r/pull/707', user: { login: 'dev3' }, created_at: '2026-07-08T00:00:00Z', updated_at: '2026-07-09T00:00:00Z', closed_at: '2026-07-09T00:00:00Z', merged_at: '2026-07-09T00:00:00Z' };
    if (path.includes('/issues/')) return { number: 101, title: 'Linked issue', body: null, state: 'open', labels: [], assignees: [], comments: 0, html_url: 'https://github.com/o/r/issues/101', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-09T00:00:00Z', closed_at: null };
    return { items: [] };
  })
}));

vi.mock('../src/lib/github.js', () => ({ githubJson: mocks.githubJson }));

const { linked_work } = await import('../src/core/linked-work.js');

describe('linked_work', () => {
  it('detects open linked pull requests from timeline cross-references', async () => {
    const result = await linked_work({ repo: 'o/r', issue_number: 101 });
    expect(result.signals).toContain('linked_pr_open');
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'linked_pr', number: 202, state: 'open', author: 'dev1', source: 'timeline' }));
    expect(result.not_checked.join(' ')).toContain('PR linkage depends on GitHub cross-reference events');
  });

  it('emits current assignees with assignment dates', async () => {
    const result = await linked_work({ repo: 'o/r', issue_number: 303 });
    expect(result.signals).toContain('assigned');
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'assignment', assignee: 'owner1', assigned_at: '2026-07-07T00:00:00Z', assigned_by: 'maintainer' }));
  });

  it('falls back to PR search for explicit issue-number mentions', async () => {
    const result = await linked_work({ repo: 'o/r', issue_number: 404 });
    expect(result.signals).toContain('linked_pr_open');
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'linked_pr', number: 505, draft: true, source: 'search' }));
  });

  it('detects pull request URLs referenced in issue comments', async () => {
    const result = await linked_work({ repo: 'o/r', issue_number: 606 });
    expect(result.signals).toContain('linked_pr_merged');
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'linked_pr', number: 707, merged: true, source: 'comment', referrer: 'https://github.com/o/r/issues/606#issuecomment-1' }));
  });

  it('emits linked_pr_closed for closed unmerged linked pull requests', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path.includes('/repos/o/r') && !path.includes('/issues') && !path.includes('/pulls') && !path.includes('/search')) {
        return { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
      }
      if (path.includes('/issues/808/timeline')) return [
        { event: 'cross-referenced', created_at: '2026-07-09T00:00:00Z', source: { type: 'issue', issue: { number: 809, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/809' } } } }
      ];
      if (path.includes('/issues/808/comments')) return [];
      if (path.includes('/pulls/809')) return { number: 809, state: 'closed', draft: false, merged: false, title: 'Abandoned fix', html_url: 'https://github.com/o/r/pull/809', user: { login: 'dev4' }, created_at: '2026-07-08T00:00:00Z', updated_at: '2026-07-09T00:00:00Z', closed_at: '2026-07-09T00:00:00Z', merged_at: null };
      if (path.includes('/search/issues')) return { items: [] };
      if (path.includes('/issues/808')) return { number: 808, title: 'Closed PR issue', body: null, state: 'open', labels: [], assignees: [], comments: 0, html_url: 'https://github.com/o/r/issues/808', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-09T00:00:00Z', closed_at: null };
      return { items: [] };
    });
    const result = await linked_work({ repo: 'o/r', issue_number: 808 });
    expect(result.signals).toContain('linked_pr_closed');
    expect(result.signals).not.toContain('linked_pr_open');
    expect(result.signals).not.toContain('linked_pr_merged');
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: 'linked_pr', number: 809, state: 'closed', merged: false, source: 'timeline' }));
  });
});
