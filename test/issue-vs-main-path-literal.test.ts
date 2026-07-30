import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issue_vs_main } from '../src/core/issue-vs-main.js';
import { commitFixtureFiles, initGitFixture } from './helpers/git-fixture.js';

let fixtureDir: string;
let cleanupFixture: () => Promise<void>;

vi.mock('../src/lib/github.js', () => ({
  githubJson: vi.fn(async () => ({
    number: 3924,
    title: 'Update snippets/price.liquid behavior',
    body: 'The bug is in snippets/price.liquid. Please adjust price display behavior.',
    state: 'open',
    labels: [],
    comments: 0,
    html_url: 'https://github.com/Shopify/dawn/issues/3924',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null
  }))
}));

vi.mock('../src/lib/git.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/git.js')>('../src/lib/git.js');
  return {
    shallowClone: vi.fn(async () => ({ dir: fixtureDir, cleanup: async () => undefined, cached: false })),
    listCloneFiles: vi.fn(async () => ({ files: await actual.listTreeFiles(fixtureDir), cached: false, dir: fixtureDir })),
    readClonedFilesBatch: vi.fn(async (_repo: string, filePaths: string[]) => {
      const files = await actual.listTreeFiles(fixtureDir);
      const wanted = files.filter((entry) => filePaths.includes(entry.path));
      return actual.readTreeFilesBatch(fixtureDir, wanted);
    })
  };
});

describe('issue_vs_main path literal handling', () => {
  beforeEach(async () => {
    const fixture = await initGitFixture('gitworthy-path-literal-');
    fixtureDir = fixture.dir;
    cleanupFixture = fixture.cleanup;
    await commitFixtureFiles(fixtureDir, {
      'snippets/price.liquid': '{{ price }}\n'
    });
  });

  afterEach(async () => {
    await cleanupFixture();
  });

  it('does not emit shipped when an issue merely names an existing path', async () => {
    const result = await issue_vs_main({ repo: 'Shopify/dawn', issue_number: 3924 });
    expect(JSON.stringify(result.evidence)).toContain('snippets/price.liquid');
    expect(result.verdict_summary).toBe('partial overlap found.');
    expect(result.signals).toEqual(['needs_repro']);
  });
});
