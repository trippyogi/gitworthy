import { beforeEach, describe, expect, it, vi } from 'vitest';

const OPEN_ISSUES = [
  {
    number: 1,
    title: 'Login page crashes with TypeError on submit button',
    body: 'Steps: navigate to login page, click submit button, observe crash. Error: TypeError: cannot read properties of undefined reading value',
    state: 'open',
    labels: [{ name: 'bug' }],
    comments: 0,
    html_url: 'https://github.com/o/r/issues/1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null
  },
  {
    number: 2,
    title: 'Login form crashes with TypeError when submitting button',
    body: 'Steps: open login form, click submit button, app crashes with TypeError: cannot read properties of undefined reading value',
    state: 'open',
    labels: [{ name: 'bug' }],
    comments: 0,
    html_url: 'https://github.com/o/r/issues/2',
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: null
  },
  {
    number: 3,
    title: 'Add dark mode toggle to settings',
    body: 'Feature request: allow users to switch between light and dark themes from the settings panel',
    state: 'open',
    labels: [{ name: 'enhancement' }],
    comments: 0,
    html_url: 'https://github.com/o/r/issues/3',
    created_at: '2026-01-03T00:00:00Z',
    updated_at: '2026-01-03T00:00:00Z',
    closed_at: null
  },
  {
    number: 4,
    title: 'Fix login crash',
    body: null,
    state: 'open',
    labels: [],
    comments: 0,
    html_url: 'https://github.com/o/r/pull/4',
    created_at: '2026-01-04T00:00:00Z',
    updated_at: '2026-01-04T00:00:00Z',
    closed_at: null,
    pull_request: { url: 'https://api.github.com/repos/o/r/pulls/4' }
  }
];

const CLOSED_SEED_ISSUE = {
  number: 5,
  title: 'Add dark mode toggle option to settings',
  body: 'Feature request: allow users to switch between light and dark theme from the settings panel option',
  state: 'closed',
  labels: [{ name: 'enhancement' }],
  comments: 0,
  html_url: 'https://github.com/o/r/issues/5',
  created_at: '2025-12-01T00:00:00Z',
  updated_at: '2025-12-05T00:00:00Z',
  closed_at: '2025-12-05T00:00:00Z'
};

function defaultGithubJson(path: string): unknown {
  if (path.startsWith('/repos/o/r/issues?')) return OPEN_ISSUES;
  if (path === '/repos/o/r/issues/1') return OPEN_ISSUES[0];
  if (path === '/repos/o/r/issues/5') return CLOSED_SEED_ISSUE;
  return [];
}

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(async (path: string) => defaultGithubJson(path))
}));

vi.mock('../src/lib/github.js', () => ({ githubJson: mocks.githubJson }));

const { related_cluster } = await import('../src/core/related-cluster.js');

beforeEach(() => {
  mocks.githubJson.mockReset();
  mocks.githubJson.mockImplementation(async (path: string) => defaultGithubJson(path));
});

describe('related_cluster', () => {
  it('finds a related issue above threshold for a seed issue', async () => {
    const result = await related_cluster({ repo: 'o/r', issue_number: 1 });

    const clusters = result.evidence.filter((item) => item.kind === 'related_cluster');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      kind: 'related_cluster',
      size: 2,
      members: [
        expect.objectContaining({ number: 1, title: expect.stringContaining('Login page') }),
        expect.objectContaining({ number: 2, title: expect.stringContaining('Login form') })
      ]
    });
    expect(clusters[0].score).toBeGreaterThanOrEqual(0.35);

    const seedCluster = result.evidence.find((item) => item.kind === 'seed_cluster');
    expect(seedCluster).toMatchObject({
      kind: 'seed_cluster',
      issue_number: 1,
      cluster_id: clusters[0].id,
      related: [expect.objectContaining({ number: 2 })]
    });

    expect(result.signals).toEqual([]);
    expect(result.checked).toContain('excluded pull requests');
    expect(result.checked.some((item) => item.includes('fetched seed issue o/r#1'))).toBe(true);
    expect(result.not_checked.join(' ')).toContain('no embeddings');
    expect(result.verdict_summary).toContain('found 1 related cluster among 3 issues');
  });

  it('excludes the unrelated singleton issue from cluster evidence', async () => {
    const result = await related_cluster({ repo: 'o/r', issue_number: 1 });
    const clusters = result.evidence.filter((item) => item.kind === 'related_cluster');
    const allMemberNumbers = clusters.flatMap((cluster) => cluster.members.map((member: { number: number }) => member.number));
    expect(allMemberNumbers).not.toContain(3);
  });

  it('includes a closed seed issue even though it is not in the open issue list', async () => {
    const result = await related_cluster({ repo: 'o/r', issue_number: 5 });

    expect(result.checked.some((item) => item.includes('fetched seed issue o/r#5'))).toBe(true);
    const seedCluster = result.evidence.find((item) => item.kind === 'seed_cluster');
    expect(seedCluster).toMatchObject({
      kind: 'seed_cluster',
      issue_number: 5,
      related: [expect.objectContaining({ number: 3 })]
    });

    const clusters = result.evidence.filter((item) => item.kind === 'related_cluster');
    expect(clusters.some((cluster) => cluster.members.some((member: { number: number }) => member.number === 5))).toBe(true);
  });

  it('returns clusters for scan triage without a seed issue', async () => {
    const result = await related_cluster({ repo: 'o/r' });

    expect(result.evidence.every((item) => item.kind === 'related_cluster')).toBe(true);
    const clusters = result.evidence.filter((item) => item.kind === 'related_cluster');
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((member: { number: number }) => member.number).sort()).toEqual([1, 2]);
  });

  it('applies the label filter as a query parameter', async () => {
    await related_cluster({ repo: 'o/r', label: 'bug' });
    expect(mocks.githubJson).toHaveBeenCalledWith(expect.stringContaining('labels=bug'));
  });

  it('filters candidates by keywords found in title or body', async () => {
    const result = await related_cluster({ repo: 'o/r', keywords: ['dark mode'] });
    const clusters = result.evidence.filter((item) => item.kind === 'related_cluster');
    expect(clusters).toHaveLength(0);
    expect(result.verdict_summary).toContain('among 1 issue');
  });

  it('respects a singleton seed with no related issues', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/repos/o/r/issues?')) return [OPEN_ISSUES[2]];
      if (path === '/repos/o/r/issues/3') return OPEN_ISSUES[2];
      return [];
    });
    const result = await related_cluster({ repo: 'o/r', issue_number: 3 });
    const seedCluster = result.evidence.find((item) => item.kind === 'seed_cluster');
    expect(seedCluster).toMatchObject({ kind: 'seed_cluster', issue_number: 3, related: [] });
    expect(result.evidence.filter((item) => item.kind === 'related_cluster')).toHaveLength(0);
  });

  it('clamps limit to the documented max and default', async () => {
    const result = await related_cluster({ repo: 'o/r', limit: 500 });
    expect(result.checked.some((item) => item.includes('considered up to 100 open candidate issue(s)'))).toBe(true);
  });
});
