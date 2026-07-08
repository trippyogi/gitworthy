import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issue_vs_main } from '../src/core/issue-vs-main.js';

let fixtureDir: string;

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

vi.mock('../src/lib/git.js', () => ({
  shallowClone: vi.fn(async () => ({ dir: fixtureDir, cleanup: async () => undefined }))
}));

describe('issue_vs_main path literal handling', () => {
  beforeEach(async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-path-literal-'));
    await mkdir(path.join(fixtureDir, 'snippets'), { recursive: true });
    await writeFile(path.join(fixtureDir, 'snippets', 'price.liquid'), '{{ price }}\n');
  });

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('does not emit shipped when an issue merely names an existing path', async () => {
    const result = await issue_vs_main({ repo: 'Shopify/dawn', issue_number: 3924 });
    expect(JSON.stringify(result.evidence)).toContain('snippets/price.liquid');
    expect(result.verdict_summary).toBe('partial overlap found.');
    expect(result.signals).toEqual([]);
  });
});
