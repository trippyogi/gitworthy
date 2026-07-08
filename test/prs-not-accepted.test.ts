import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/github.js', () => ({
  fetchRaw: vi.fn(async (_repo: string, _branch: string, file: string) => {
    if (file === 'CONTRIBUTING.md') return `# Contributing\n\nThis repository is a mirror repo. Pull requests are not accepted here. Please contribute in the upstream project.`;
    return null;
  })
}));

const { contrib_policy } = await import('../src/core/contrib-policy.js');

describe('mirror repository contribution policy', () => {
  it('surfaces PRs-not-accepted as a first-class signal', async () => {
    const result = await contrib_policy({ repo: 'mirror/repo', force_refresh: true });
    expect(result.signals).toContain('prs_not_accepted');
    expect(result.evidence.some((item) => item.category === 'prs_not_accepted')).toBe(true);
    expect(JSON.stringify(result.evidence)).toContain('Pull requests are not accepted');
  });
});
