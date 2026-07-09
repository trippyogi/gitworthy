import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(async () => [
    { number: 1, title: 'Add typed config', body: null, state: 'open', labels: [{ name: 'good first issue' }], assignees: [{ login: 'maintainer1' }], comments: 2, html_url: 'https://github.com/o/r/issues/1', created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), updated_at: '2026-01-02T00:00:00Z', closed_at: null },
    { number: 2, title: 'Fix old docs', body: null, state: 'open', labels: [{ name: 'good first issue' }], comments: 0, html_url: 'https://github.com/o/r/issues/2', created_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(), updated_at: '2026-01-03T00:00:00Z', closed_at: null },
    { number: 3, title: 'Improve typed output', body: null, state: 'open', labels: [{ name: 'help wanted' }], comments: 5, html_url: 'https://github.com/o/r/issues/3', created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), updated_at: '2026-01-04T00:00:00Z', closed_at: null },
    { number: 4, title: 'Add typed pull request', body: null, state: 'open', labels: [{ name: 'good first issue' }], comments: 1, html_url: 'https://github.com/o/r/pull/4', created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), updated_at: '2026-01-05T00:00:00Z', closed_at: null, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/4' } }
  ]),
  readCache: vi.fn(async () => ({ hit: false }))
}));

vi.mock('../src/lib/github.js', () => ({ githubJson: mocks.githubJson }));
vi.mock('../src/lib/cache.js', () => ({ readCache: mocks.readCache }));

const { scan } = await import('../src/core/scan.js');

describe('scan', () => {
  it('lists tracker candidates without verdict signals', async () => {
    mocks.readCache.mockResolvedValueOnce({ hit: false });
    const result = await scan({ repo: 'o/r', label: 'good first issue', keywords: ['typed'], since: '90d', limit: 10 });
    expect(mocks.githubJson).toHaveBeenCalledWith(expect.stringContaining('labels=good+first+issue'));
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ number: 1, title: 'Add typed config', comments: 2, assignees: ['maintainer1'] });
    expect(JSON.stringify(result.evidence)).not.toContain('pull request');
    expect(result.checked).toContain('excluded pull requests');
    expect(result.signals).toEqual([]);
    expect(result.not_checked.join(' ')).toContain('scan reflects the issue tracker only');
    expect(result.not_checked.join(' ')).toContain('not vetted contribution targets');
    expect(result.not_checked.join(' ')).toContain('run gitworthy policy o/r before investing');
  });

  it('adds a cached no-PR policy hint before issue titles need review', async () => {
    mocks.readCache.mockResolvedValueOnce({ hit: true, value: { verdict_summary: 'found 1 contribution policy signal.', evidence: [{ category: 'no_pr_path', feedback_channel: 'Shopify Developer Community' }], signals: ['no_pr_path'], checked: ['mock policy'], not_checked: ['mock limit'], cached: false, fetched_at: '2026-01-01T00:00:00.000Z' }, fetched_at: '2026-01-01T00:00:00.000Z' });
    const result = await scan({ repo: 'o/r', limit: 1 });
    expect(result.checked).toContain('policy hint: cached contrib_policy says repo accepts no pull requests; feedback channel: Shopify Developer Community');
  });

  it('is wired through the CLI', async () => {
    mocks.readCache.mockResolvedValueOnce({ hit: false });
    let stdout = '';
    const code = await runCli(['scan', 'o/r', '--label', 'good first issue', '--keywords', 'typed', '--since', '90d', '--limit', '10', '--json'], (text) => { stdout += text; });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).evidence[0].number).toBe(1);
  });
});
