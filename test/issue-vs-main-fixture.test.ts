import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issue_vs_main } from '../src/core/issue-vs-main.js';
import { commitFixtureFiles, initGitFixture } from './helpers/git-fixture.js';

let fixtureDir: string;
let cleanupFixture: () => Promise<void>;

vi.mock('../src/lib/github.js', () => ({
  githubJson: vi.fn(async () => ({
    number: 49,
    title: 'Add FastAPI Python example',
    body: 'Please add the missing FastAPI example app.',
    state: 'open',
    labels: [],
    comments: 0,
    html_url: 'https://github.com/PostHog/context-mill/issues/49',
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

describe('issue_vs_main local fixture tree', () => {
  beforeEach(async () => {
    const fixture = await initGitFixture('gitworthy-issue-fixture-');
    fixtureDir = fixture.dir;
    cleanupFixture = fixture.cleanup;
    await commitFixtureFiles(fixtureDir, {
      'example-apps/fastapi/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
      'example-apps/android/README.md': 'Android example\n'
    });
  });

  afterEach(async () => {
    await cleanupFixture();
  });

  it('surfaces inferred example-apps/fastapi paths and emits shipped', async () => {
    const result = await issue_vs_main({ repo: 'PostHog/context-mill', issue_number: 49 });
    expect(JSON.stringify(result.evidence)).toContain('example-apps/fastapi');
    expect(result.signals).toContain('shipped');
  });
});
