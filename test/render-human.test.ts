import { describe, expect, it } from 'vitest';
import { renderHuman } from '../src/cli/render-human.js';

describe('renderHuman', () => {
  it('renders multi-line check output with next action and limitations', () => {
    const text = renderHuman({
      command: 'check',
      verdict: 'SKIP',
      disposition: 'land_only',
      verdict_summary: 'Open PR #4499 explicitly closes issue #4487.',
      next_actions: [{ kind: 'land', message: 'LAND #4499: review or help land the primary closing PR.' }],
      findings: [{
        type: 'linked_pr_open',
        strength: 'definitive',
        message: 'Open PR #4499 closes the issue.',
        url: 'https://github.com/acme/widgets/pull/4499'
      }],
      checked: ['linked_work'],
      not_checked: ['issue_vs_main skipped after definitive open closing PR'],
      metrics: { duration_ms: 120, github_requests: 4, cache_hits: 1 }
    });
    expect(text).toContain('SKIP · land_only');
    expect(text).toContain('Open PR #4499 explicitly closes issue #4487.');
    expect(text).toContain('Next');
    expect(text).toContain('LAND #4499');
    expect(text).toContain('Evidence');
    expect(text).toContain('https://github.com/acme/widgets/pull/4499');
    expect(text).toContain('Not checked');
    expect(text).not.toContain('Counters');
  });

  it('includes counters only when verbose', () => {
    const text = renderHuman({
      verdict: 'ACT',
      disposition: 'greenfield',
      verdict_summary: 'no blocking evidence found by completed checks.',
      metrics: { duration_ms: 50, github_requests: 2 }
    }, { verbose: true });
    expect(text).toContain('Counters');
    expect(text).toContain('github_requests=2');
  });
});
