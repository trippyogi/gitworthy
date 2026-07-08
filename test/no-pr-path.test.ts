import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/github.js', () => ({
  fetchRaw: vi.fn(async (_repo: string, _branch: string, file: string) => {
    if (file === 'CONTRIBUTING.md') return `# Contributing\n\nThis repository is a mirror repo. Pull requests are not accepted here. Please provide feedback through the Shopify Developer Community.`;
    return null;
  })
}));

const { contrib_policy } = await import('../src/core/contrib-policy.js');

describe('no PR path contribution policy', () => {
  it('surfaces no_pr_path and extracts the alternate feedback channel', async () => {
    const result = await contrib_policy({ repo: 'Shopify/Shopify-AI-Toolkit', force_refresh: true });
    expect(result.signals).toContain('no_pr_path');
    const evidence = result.evidence.find((item) => item.category === 'no_pr_path');
    expect(evidence).toMatchObject({ feedback_channel: 'Shopify Developer Community' });
    expect(JSON.stringify(result.evidence)).toContain('Pull requests are not accepted');
  });
});
