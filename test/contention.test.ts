import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { buildEquivalenceClasses, classifyPair, claimsSuperseded } from '../src/core/diff-overlap.js';
import { analyzeGaps } from '../src/core/gap-analysis.js';
import { assessSwarmRisk } from '../src/core/swarm-risk.js';
import { extractTouchedPaths, extractTouchedSymbols, summarizeDiff } from '../src/lib/github-diff.js';
import { createContentionBudget, tryConsumeBudget, provenanceFooter } from '../src/lib/contention-budget.js';
import { ContentionReportSchema, type ContentionClaim } from '../src/contracts/contention.js';

function claim(partial: Partial<ContentionClaim> & Pick<ContentionClaim, 'pr' | 'title'>): ContentionClaim {
  return {
    repo: 'acme/widgets',
    state: 'open',
    draft: false,
    merged: false,
    author: 'dev',
    url: `https://github.com/acme/widgets/pull/${partial.pr}`,
    created_at: '2026-01-01T00:00:00.000Z',
    source: 'timeline',
    closes_issue: true,
    touched_paths: [],
    touched_symbols: [],
    ...partial
  };
}

describe('diff heuristics (GW-041)', () => {
  it('extracts paths and symbols from unified diffs', () => {
    const diff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -10,3 +10,6 @@ export function matchAppId(input: string) {',
      ' export function matchAppId(input: string) {',
      '+export function _app_id(value: string) {',
      '+  return value;',
      '+}',
      ''
    ].join('\n');
    expect(extractTouchedPaths(diff)).toEqual(['src/auth.ts']);
    expect(extractTouchedSymbols(diff)).toEqual(expect.arrayContaining(['matchAppId', '_app_id']));
    expect(summarizeDiff(diff).additions).toBeGreaterThan(0);
  });

  it('classifies same-change vs overlapping claims', () => {
    const a = claim({
      pr: 100,
      title: 'fix app id',
      touched_paths: ['src/auth.ts', 'test/auth.test.ts'],
      touched_symbols: ['_app_id'],
      diff_stat: { additions: 38, deletions: 0, changed_files: 2 }
    });
    const b = claim({
      pr: 102,
      title: 'broader ids',
      touched_paths: ['src/auth.ts', 'src/policy.ts'],
      touched_symbols: ['_app_id', '_client_id', '_bot_id'],
      diff_stat: { additions: 62, deletions: 0, changed_files: 2 }
    });
    expect(classifyPair(a, b).relation).toMatch(/same_change|overlapping/);
    const classes = buildEquivalenceClasses([a, b]);
    expect(classes).toHaveLength(1);
    expect(classes[0]!.representative).toBe(100);
  });

  it('detects superseded when closed PR overlaps open claim', () => {
    const open = claim({
      pr: 100,
      title: 'open',
      state: 'open',
      touched_paths: ['src/auth.ts'],
      touched_symbols: ['_app_id']
    });
    const closed = claim({
      pr: 102,
      title: 'closed excess',
      state: 'closed',
      merged: false,
      touched_paths: ['src/auth.ts', 'src/policy.ts'],
      touched_symbols: ['_app_id', '_client_id']
    });
    const classes = buildEquivalenceClasses([open, closed]);
    expect(claimsSuperseded([open, closed], classes)).toBe(true);
  });
});

describe('gap and swarm (GW-042)', () => {
  it('flags scope_excess for draft symbols outside issue ask', () => {
    const gaps = analyzeGaps({
      issueTitle: 'Guard should match app id',
      issueBody: '## Proposed Fix\n\nOnly touch `_app_id`.\n\n```ts\nfunction _app_id() {}\n```\n',
      labels: ['sweeper:risk-compatibility'],
      claims: [
        claim({
          pr: 100,
          title: 'fix',
          touched_paths: ['src/auth.ts'],
          touched_symbols: ['_app_id']
        })
      ],
      classes: [],
      draft: {
        paths: ['src/auth.ts'],
        symbols: ['_app_id', '_client_id', '_bot_id', '_phone_number_id']
      }
    });
    expect(gaps.some((gap) => gap.kind === 'scope_excess')).toBe(true);
    expect(gaps.some((gap) => gap.kind === 'adjacent_risk')).toBe(true);
  });

  it('marks proposed-fix issues as high swarm risk', () => {
    const result = assessSwarmRisk({
      issueBody: '## Proposed Fix\n\n```ts\nconst x = 1\n```\n',
      labels: [],
      issueCreatedAt: new Date().toISOString(),
      claimCount: 0
    });
    expect(result.swarm_risk).toBe('high');
    expect(result.posture).toBe('race');
  });
});

describe('budget provenance (GW-041 C5)', () => {
  it('truncates and documents budget exhaustion', () => {
    const budget = createContentionBudget(100);
    const first = tryConsumeBudget(budget, 80, 'a.diff');
    expect(first.truncated).toBe(false);
    const second = tryConsumeBudget(budget, 50, 'b.diff');
    expect(second.truncated).toBe(true);
    expect(budget.truncated).toBe(true);
    const footer = provenanceFooter({
      claimCount: 2,
      issueBytes: 1024,
      discussionBytes: 0,
      commentCount: 0,
      verdictCount: 1,
      budget
    });
    expect(footer).toMatch(/Contention analysis/);
    expect(footer).toMatch(/Truncated/);
  });
});

describe('contention report schema', () => {
  it('accepts a minimal valid report', () => {
    const report = ContentionReportSchema.parse({
      contention_version: 1,
      state: 'contested',
      claims: [claim({ pr: 1, title: 'a' })],
      equivalence_classes: [],
      gaps: [],
      swarm_risk: 'medium',
      posture: 'differentiate',
      provenance: {
        bytes_read: 10,
        artifacts_read: 1,
        truncated: false,
        verdict_count: 1,
        budget_bytes: 1000,
        footer: 'Contention analysis: 1 PRs and 1 issue in this complex. Each diff read against the issue. Working set: 0.0 kB PR diffs, 0.0 kB issue text, 0.0 kB discussion (0 comments), 1 verdicts. Verdicts reflect diff content, not PR titles.'
      },
      low_confidence: false
    });
    expect(report.state).toBe('contested');
  });
});

const githubMocks = vi.hoisted(() => ({
  githubJson: vi.fn(),
  linked_work: vi.fn(),
  lsRemoteHeads: vi.fn()
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: githubMocks.githubJson,
  githubToken: () => 'test-token',
  fetchRaw: vi.fn(async () => null),
  clearGithubCachesForTests: vi.fn(),
  configureGithubHttpForTests: vi.fn()
}));

vi.mock('../src/core/linked-work.js', () => ({
  linked_work: githubMocks.linked_work
}));

vi.mock('../src/lib/git.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/git.js')>('../src/lib/git.js');
  return {
    ...actual,
    lsRemoteHeads: githubMocks.lsRemoteHeads
  };
});

vi.mock('../src/lib/github-diff.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/github-diff.js')>('../src/lib/github-diff.js');
  return {
    ...actual,
    fetchPullDiff: vi.fn(async (_repo: string, pr: number) => {
      const diff = [
        'diff --git a/src/auth.ts b/src/auth.ts',
        '@@ -1,1 +1,3 @@ export function _app_id() {',
        '+export function _app_id() { return 1 }',
        pr === 102 ? '+export function _client_id() { return 2 }' : '',
        ''
      ].filter(Boolean).join('\n');
      return {
        text: diff,
        bytes: Buffer.byteLength(diff),
        truncated: false,
        additions: pr === 102 ? 2 : 1,
        deletions: 0,
        changed_files: 1
      };
    })
  };
});

describe('contention() integration (GW-040–042)', () => {
  beforeEach(() => {
    githubMocks.githubJson.mockImplementation(async (path: string) => {
      if (path.includes('/issues/')) {
        return {
          number: 76793,
          title: 'match app id',
          body: '## Proposed Fix\n\n```ts\n_app_id\n```\nOnly `_app_id`.\n',
          state: 'open',
          labels: [{ name: 'sweeper:risk-compatibility' }],
          comments: 0,
          html_url: 'https://github.com/acme/widgets/issues/76793',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          closed_at: null
        };
      }
      return {};
    });
    githubMocks.lsRemoteHeads.mockResolvedValue([{ name: 'fix-76793-app-id', sha: 'abc' }]);
    githubMocks.linked_work.mockResolvedValue({
      verdict_summary: 'linked',
      evidence: [
        {
          kind: 'linked_pr',
          number: 100,
          state: 'open',
          draft: false,
          merged: false,
          date: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          author: 'a',
          title: 'fix app id',
          url: 'https://github.com/acme/widgets/pull/100',
          source: 'timeline',
          closes_issue: true
        },
        {
          kind: 'linked_pr',
          number: 102,
          state: 'closed',
          draft: false,
          merged: false,
          date: '2026-01-01T01:00:00Z',
          author: 'b',
          title: 'broader fix',
          url: 'https://github.com/acme/widgets/pull/102',
          source: 'timeline',
          closes_issue: true
        }
      ],
      signals: ['linked_pr_open', 'linked_pr_closed'],
      checked: ['linked'],
      not_checked: ['limit'],
      cached: false,
      fetched_at: new Date().toISOString()
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns superseded/contested report with provenance footer', async () => {
    const { contention } = await import('../src/core/contention.js');
    const result = await contention({ repo: 'acme/widgets', issue_number: 76793 });
    expect(result.contention.state).toMatch(/contested|superseded/);
    expect(result.contention.claims).toHaveLength(2);
    expect(result.contention.provenance.footer).toMatch(/Contention analysis/);
    expect(result.verdict_summary).toMatch(/76793/);
    expect(JSON.stringify(result.evidence)).toMatch(/claim_branches/);
  });
});
