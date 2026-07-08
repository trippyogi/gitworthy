import { describe, expect, it, vi } from 'vitest';
import { branch_scan } from '../src/core/branch-scan.js';
import { worth_check } from '../src/core/worth-check.js';
import { runCli } from '../src/cli/index.js';

vi.mock('../src/lib/git.js', () => ({
  lsRemoteHeads: vi.fn(async () => [{ name: 'feature-sleep-fix', sha: 'abc' }]),
  shallowClone: vi.fn(async () => ({ dir: process.cwd(), cleanup: async () => undefined }))
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: vi.fn(async (requestPath: string) => {
    if (requestPath.includes('/commits/')) return { commit: { author: { date: new Date().toISOString() }, message: 'fix sleep' }, html_url: 'https://github.com/o/r/commit/abc' };
    if (requestPath.includes('/issues/')) return { number: 1, title: 'sleep fix', body: 'sleep', state: 'open', labels: [], comments: 0, html_url: 'https://github.com/o/r/issues/1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null };
    if (requestPath.includes('/search/issues')) return { items: [] };
    if (requestPath.includes('/issues?')) return [];
    return {};
  }),
  fetchRaw: vi.fn(async () => null)
}));

vi.mock('../src/lib/registry.js', () => ({
  npmMetadata: vi.fn(async () => ({ name: 'pkg', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz' } } }, time: { '1.0.0': '2026-01-01T00:00:00.000Z' } })),
  readPackageJsonFromClone: vi.fn(async () => ({ name: 'pkg', version: '1.0.0' })),
  downloadAndExtractTarball: vi.fn(async () => ({ dir: process.cwd(), cleanup: async () => undefined }))
}));

describe('structured signals and CLI polish', () => {
  it('emits in_flight and worth_check drives SKIP from signals', async () => {
    const branch = await branch_scan({ repo: 'o/r', keywords: ['sleep'], force_refresh: true });
    expect(branch.signals).toEqual(['in_flight']);
    const worth = await worth_check({ repo: 'o/r', issue_number: 1 });
    expect(worth.verdict).toBe('SKIP');
    expect(worth.reasons.join(' ')).toContain('in_flight');
  });

  it('dedupes human-readable verdict prefixes and warns for dash keywords', async () => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['branches', 'o/r', '-sleep', '--json', '--force-refresh'], (text) => { stdout += text; }, (text) => { stderr += text; });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).signals).toEqual(['in_flight']);
    expect(stderr).toContain('starts with a dash');
  });
});
