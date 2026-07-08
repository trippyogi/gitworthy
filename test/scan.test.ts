import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(async () => [
    { number: 1, title: 'Add typed config', body: null, state: 'open', labels: [{ name: 'good first issue' }], comments: 2, html_url: 'https://github.com/o/r/issues/1', created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), updated_at: '2026-01-02T00:00:00Z', closed_at: null },
    { number: 2, title: 'Fix old docs', body: null, state: 'open', labels: [{ name: 'good first issue' }], comments: 0, html_url: 'https://github.com/o/r/issues/2', created_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(), updated_at: '2026-01-03T00:00:00Z', closed_at: null },
    { number: 3, title: 'Improve typed output', body: null, state: 'open', labels: [{ name: 'help wanted' }], comments: 5, html_url: 'https://github.com/o/r/issues/3', created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), updated_at: '2026-01-04T00:00:00Z', closed_at: null }
  ])
}));

vi.mock('../src/lib/github.js', () => ({ githubJson: mocks.githubJson }));

const { scan } = await import('../src/core/scan.js');

describe('scan', () => {
  it('lists tracker candidates without verdict signals', async () => {
    const result = await scan({ repo: 'o/r', label: 'good first issue', keywords: ['typed'], since: '90d', limit: 10 });
    expect(mocks.githubJson).toHaveBeenCalledWith(expect.stringContaining('labels=good+first+issue'));
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ number: 1, title: 'Add typed config', comments: 2 });
    expect(result.signals).toEqual([]);
    expect(result.not_checked.join(' ')).toContain('scan reflects the issue tracker only');
    expect(result.not_checked.join(' ')).toContain('not vetted contribution targets');
  });

  it('is wired through the CLI', async () => {
    let stdout = '';
    const code = await runCli(['scan', 'o/r', '--label', 'good first issue', '--keywords', 'typed', '--since', '90d', '--limit', '10', '--json'], (text) => { stdout += text; });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).evidence[0].number).toBe(1);
  });
});
