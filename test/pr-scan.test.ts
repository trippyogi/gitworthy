import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpportunityTargetSchema } from '../src/contracts/opportunities.js';
import { PR_ENRICH_LIMIT, PR_INVENTORY_LIMIT, PrScanFilterSchema } from '../src/contracts/pr-scan.js';
import {
  cheapRankScore,
  classifyPrHint,
  extractLinkedIssueNumber,
  filterInventoryReason,
  isGeneratedPr
} from '../src/core/pr-scan.js';

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn(),
  contention: vi.fn(),
  fetchPullDiff: vi.fn()
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: mocks.githubJson,
  githubToken: () => 'test-token'
}));

vi.mock('../src/core/contention.js', () => ({
  contention: mocks.contention
}));

vi.mock('../src/lib/github-diff.js', () => ({
  fetchPullDiff: mocks.fetchPullDiff,
  extractTouchedPaths: (text: string) => [...text.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1] ?? '')
}));

const { pr_scan } = await import('../src/core/pr-scan.js');

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 10,
    title: 'Fix crash on Windows',
    body: 'Fixes #88\n\nSteps to reproduce included.',
    state: 'open',
    draft: false,
    merged_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    user: { login: 'alice' },
    labels: [{ name: 'bug' }],
    head: { sha: 'abc123' },
    additions: 40,
    deletions: 8,
    changed_files: 4,
    ...overrides
  };
}

describe('OpportunityTargetSchema', () => {
  it('accepts issue, pull_request, and eval_anomaly without changing TargetIdentity', () => {
    expect(OpportunityTargetSchema.parse({ kind: 'issue', repo: 'o/r', issue_number: 1 }).kind).toBe('issue');
    expect(OpportunityTargetSchema.parse({
      kind: 'pull_request', repo: 'o/r', pr_number: 9, linked_issue_number: 3
    }).kind).toBe('pull_request');
    expect(OpportunityTargetSchema.parse({
      kind: 'eval_anomaly', external_id: 'eval-1', source: 'hermes-eval'
    }).kind).toBe('eval_anomaly');
  });
});

describe('cheap inventory filters and rank', () => {
  const filters = PrScanFilterSchema.parse({});

  it('filters bots, merged PRs, and generated dependency PRs', () => {
    expect(filterInventoryReason({ author: 'dependabot[bot]', merged: false, draft: false, title: 'Bump left-pad' }, filters)).toBe('automation_author');
    expect(filterInventoryReason({ author: 'alice', merged: true, draft: false, title: 'Fix bug' }, filters)).toBe('closed_merged');
    expect(isGeneratedPr('chore(deps): bump lodash', ['dependencies'])).toBe(true);
    expect(filterInventoryReason({
      author: 'alice', merged: false, draft: false, title: 'chore(deps): bump lodash', labels: ['dependencies']
    }, filters)).toBe('generated');
    expect(filterInventoryReason({ author: 'alice', merged: false, draft: false, title: 'Fix crash' }, filters)).toBeUndefined();
  });

  it('ranks open linked bug PRs above stale drafts', () => {
    const open = cheapRankScore({
      draft: false, merged: false, state: 'open', updated_at: '2026-08-18T00:00:00.000Z',
      linked_issue_number: 8, title: 'Fix crash'
    });
    const staleDraft = cheapRankScore({
      draft: true, merged: false, state: 'open', updated_at: '2026-01-01T00:00:00.000Z',
      title: 'WIP refactor'
    });
    expect(open).toBeGreaterThan(staleDraft);
  });

  it('extracts a cheap closing issue number', () => {
    expect(extractLinkedIssueNumber('Fix login', 'Closes #41')).toBe(41);
    expect(extractLinkedIssueNumber('Docs only', 'No closer here')).toBeUndefined();
  });
});

describe('REVIEW / WATCH / SALVAGE heuristics', () => {
  const open = { draft: false, state: 'open' as const, merged: false };
  const closed = { draft: false, state: 'closed' as const, merged: false };

  it('does not classify age-only stale PRs as SALVAGE', () => {
    const decision = classifyPrHint({ stale: true, stale_days: 40 }, open);
    expect(decision.hint_mode).not.toBe('SALVAGE');
    expect(decision.hint_reasons.join(' ')).toMatch(/Age or inactivity alone is not abandonment/);
  });

  it('requires a high bar for SALVAGE and carries attribution constraints', () => {
    const decision = classifyPrHint({
      stale: true,
      maintainer_interest: true,
      credible_work: true,
      requested_changes: true,
      substantive: true,
      issue_open: true
    }, open);
    expect(decision.hint_mode).toBe('SALVAGE');
    expect(decision.hard_constraints).toEqual(expect.arrayContaining([
      'coordinate_before_upstream_action',
      'preserve_attribution',
      'verify_current_main'
    ]));
  });

  it('salvages a closed unmerged attempt only with maintainer-positive review and an open issue', () => {
    const strong = classifyPrHint({
      substantive: true,
      issue_open: true,
      maintainer_positive_review: true
    }, closed);
    const weak = classifyPrHint({
      substantive: true,
      issue_open: true
    }, closed);
    expect(strong.hint_mode).toBe('SALVAGE');
    expect(weak.hint_mode).not.toBe('SALVAGE');
  });

  it('watches a healthy actively reviewed PR', () => {
    const decision = classifyPrHint({
      healthy_active: true,
      maintainer_reviewed: true,
      ci_state: 'success',
      closes_issue: true
    }, open);
    expect(decision.hint_mode).toBe('WATCH');
  });

  it('increases REVIEW for competing closers, missing tests, and requested changes', () => {
    const decision = classifyPrHint({
      looks_like_bug: true,
      competing_closers: 2,
      has_tests: false,
      requested_changes: true,
      contention_gaps: ['test_coverage']
    }, open);
    expect(decision.hint_mode).toBe('REVIEW');
    expect(decision.hint_reasons.join(' ')).toMatch(/Competing closers|Requested changes|Contention gaps/);
  });
});

describe('pr_scan two-stage flow', () => {
  beforeEach(() => {
    mocks.githubJson.mockReset();
    mocks.contention.mockReset();
    mocks.fetchPullDiff.mockReset();
    mocks.fetchPullDiff.mockResolvedValue({
      text: 'diff --git a/src/app.ts b/src/app.ts\ndiff --git a/test/app.test.ts b/test/app.test.ts\n',
      bytes: 40,
      truncated: false,
      additions: 12,
      deletions: 2,
      changed_files: 2
    });
    mocks.contention.mockResolvedValue({
      contention: {
        claims: [
          { pr: 10, state: 'open', closes_issue: true },
          { pr: 11, state: 'open', closes_issue: true }
        ],
        gaps: [{ kind: 'test_coverage' }]
      }
    });
  });

  it('lists, filters, ranks, and enriches only the top N', async () => {
    const listed = [
      pull({ number: 1, title: 'chore(deps): bump left-pad', user: { login: 'dependabot[bot]' } }),
      pull({ number: 2, title: 'Merged fix', state: 'closed', merged_at: '2026-08-01T00:00:00.000Z' }),
      pull({ number: 10, title: 'Fix crash on Windows', body: 'Fixes #88' }),
      pull({ number: 11, title: 'Docs tweak', body: 'n/a', labels: [] }),
      pull({ number: 12, title: 'Closed attempt', state: 'closed', body: 'Fixes #90', merged_at: null })
    ];
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path.includes('/pulls?')) return listed;
      if (path.includes('/pulls/10/reviews') || path.includes('/pulls/11/reviews') || path.includes('/pulls/12/reviews')) {
        return [{ state: 'CHANGES_REQUESTED', author_association: 'MEMBER' }];
      }
      if (path.includes('/check-runs')) return { check_runs: [{ conclusion: 'failure', status: 'completed' }] };
      if (path.includes('/issues/')) return { state: 'open', number: 88 };
      if (path.includes('/pulls/')) {
        const number = Number(path.split('/pulls/')[1]);
        return listed.find((item) => item.number === number) ?? pull({ number });
      }
      return [];
    });

    const result = await pr_scan({ repo: 'o/r', enrich_limit: 2, inventory_limit: 10 });
    expect(result.inventory_count).toBe(5);
    expect(result.filtered_count).toBe(2);
    expect(result.enriched_count).toBeLessThanOrEqual(2);
    expect(result.opportunities.every((item) => item.target.kind === 'pull_request')).toBe(true);
    const enriched = result.opportunities.filter((item) => item.enriched);
    expect(enriched.length).toBeGreaterThan(0);
    expect(enriched[0]?.enrichment?.competing_closers).toBe(2);
    expect(mocks.contention).toHaveBeenCalled();
  });

  it('respects conceptual bounds of 25 inventory and 5 enriched', () => {
    expect(PR_INVENTORY_LIMIT).toBe(25);
    expect(PR_ENRICH_LIMIT).toBe(5);
    expect(PrScanFilterSchema.parse({ inventory_limit: 25, enrich_limit: 5 }).inventory_limit).toBe(25);
    expect(() => PrScanFilterSchema.parse({ inventory_limit: 26 })).toThrow();
  });

  it('does not salvage an unenriched stale draft', async () => {
    mocks.githubJson.mockImplementation(async (path: string) => {
      if (path.includes('/pulls?')) {
        return [
          pull({
            number: 20,
            title: 'WIP maybe later',
            body: '',
            draft: true,
            updated_at: '2026-01-01T00:00:00.000Z',
            labels: []
          }),
          pull({ number: 21, title: 'Fix crash', body: 'Fixes #3' })
        ];
      }
      if (path.includes('/reviews')) return [];
      if (path.includes('/check-runs')) return { check_runs: [] };
      if (path.includes('/issues/')) return { state: 'open' };
      return pull({ number: 21 });
    });
    const result = await pr_scan({ repo: 'o/r', enrich_limit: 1, stale_pr_days: 14 });
    const stale = result.opportunities.find((item) => item.inventory.number === 20);
    expect(stale?.hint_mode).not.toBe('SALVAGE');
  });
});
