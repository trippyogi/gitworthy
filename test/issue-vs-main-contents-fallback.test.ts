import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  shallowClone: vi.fn(async () => {
    throw Object.assign(new Error('git shallow clone failed for o/r.'), { code: 'git_clone_failed' });
  }),
  listCloneFiles: vi.fn(),
  readClonedFilesBatch: vi.fn(),
  listTreeFiles: vi.fn(),
  readTreeFilesBatch: vi.fn(),
  githubJson: vi.fn(async (path: string) => {
    if (path.includes('/repos/o/r') && !path.includes('/issues') && !path.includes('/contents')) {
      return { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
    }
    if (path.includes('/issues/1')) {
      return {
        number: 1,
        title: 'Bug in src/routes/api/route.ts',
        body: 'Fails in src/routes/api/route.ts when empty',
        state: 'open',
        labels: [{ name: 'bug' }],
        comments: 0,
        html_url: 'https://github.com/o/r/issues/1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        closed_at: null
      };
    }
    if (path.includes('/contents/')) {
      return { type: 'file', path: 'src/routes/api/route.ts', name: 'route.ts' };
    }
    return {};
  }),
  fetchRaw: vi.fn(async (_repo: string, _branch: string, filePath: string) => {
    if (filePath === 'src/routes/api/route.ts') {
      return 'export async function GET() {\n  return Response.json({ ok: true });\n}\n';
    }
    return null;
  })
}));

vi.mock('../src/lib/git.js', () => ({
  DEFAULT_MAX_TREE_FILES: 20_000,
  shallowClone: mocks.shallowClone,
  listCloneFiles: mocks.listCloneFiles,
  readClonedFilesBatch: mocks.readClonedFilesBatch,
  listTreeFiles: mocks.listTreeFiles,
  readTreeFilesBatch: mocks.readTreeFilesBatch,
  localCheckoutMatchesRepo: vi.fn(async () => false)
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: mocks.githubJson,
  fetchRaw: mocks.fetchRaw
}));

const { issue_vs_main } = await import('../src/core/issue-vs-main.js');

describe('issue_vs_main contents fallback', () => {
  it('probes named paths via contents/raw when bare clone fails', async () => {
    const result = await issue_vs_main({ repo: 'o/r', issue_number: 1 });
    expect(mocks.shallowClone).toHaveBeenCalled();
    expect(mocks.fetchRaw).toHaveBeenCalled();
    expect(result.evidence.some((item) => item.kind === 'issue_vs_main_perf' && item.mode === 'contents_fallback')).toBe(true);
    expect(result.checked.join(' ')).toMatch(/contents\/raw|clone unavailable/i);
    expect(result.not_checked.join(' ')).toContain('full repository tree was not cloned');
    const tree = result.evidence.find((item) => Array.isArray(item.tree_matches));
    expect(tree?.tree_matches).toEqual(expect.arrayContaining(['src/routes/api/route.ts']));
  });
});
