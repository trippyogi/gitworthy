import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/github.js', () => ({
  fetchRaw: vi.fn(async (_repo: string, _branch: string, file: string) => {
    if (file === 'CONTRIBUTING.md') return `# Contributing\n\nPlease include tests and screenshots as evidence for behavior changes.\n\nOpen one PR at a time and discuss large changes before opening a pull request.\n\nRefactor-only pull requests are not accepted.`;
    if (file === 'AGENTS.md') return `# Architecture\n\nThe gateway owns sessions, execution, approvals, channel routing, and live agent behavior. Nectar owns durable memory and docs.`;
    return null;
  })
}));

const { contrib_policy } = await import('../src/core/contrib-policy.js');

describe('contrib_policy noise controls', () => {
  it('does not map architecture text to cla_requirement and assigns each excerpt once', async () => {
    const result = await contrib_policy({ repo: 'PostHog/code', force_refresh: true });
    expect(result.evidence.some((item) => item.category === 'cla_requirement')).toBe(false);
    expect(result.evidence.some((item) => item.category === 'evidence_requirements')).toBe(true);
    expect(result.evidence.some((item) => item.category === 'forbidden_pr_types')).toBe(true);
    const excerpts = result.evidence.map((item) => String(item.excerpt));
    expect(new Set(excerpts).size).toBe(excerpts.length);
  });
});
