import { describe, expect, it, vi } from 'vitest';
import { hasConcretePathTerms, issue_vs_main } from '../src/core/issue-vs-main.js';

const mocks = vi.hoisted(() => ({
  shallowClone: vi.fn(),
  listCloneFiles: vi.fn(),
  githubJson: vi.fn(async () => ({
    number: 99,
    title: 'Agent type mismatch in skills docs',
    body: 'openclaw agent docs mention type incorrectly.',
    state: 'open',
    labels: [{ name: 'docs' }],
    comments: 0,
    html_url: 'https://github.com/example/openclaw/issues/99',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null
  }))
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: mocks.githubJson
}));

vi.mock('../src/lib/git.js', () => ({
  shallowClone: mocks.shallowClone,
  listCloneFiles: mocks.listCloneFiles
}));

describe('issue_vs_main concrete path gate', () => {
  it('detects concrete path terms', () => {
    expect(hasConcretePathTerms({ title: 'Fix src/foo/bar.ts', body: '' })).toBe(true);
    expect(hasConcretePathTerms({ title: 'Bug in extensions/telegram', body: '' })).toBe(true);
    expect(hasConcretePathTerms({ title: 'Agent type docs', body: 'openclaw skills mention type' })).toBe(false);
  });

  it('skips clone and grep when terms are fuzzy', async () => {
    const result = await issue_vs_main({ repo: 'example/openclaw', issue_number: 99 });
    expect(mocks.shallowClone).not.toHaveBeenCalled();
    expect(mocks.listCloneFiles).not.toHaveBeenCalled();
    expect(result.not_checked.join(' ')).toContain('no concrete path terms');
    expect(result.evidence.some((item) => item.kind === 'issue_vs_main_perf' && item.mode === 'repro_only')).toBe(true);
    expect(result.verdict_summary).toContain('no concrete path terms');
  });
});
