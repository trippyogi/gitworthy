/**
 * Contention analysis — in-flight claims, diff overlap, gaps, swarm risk (GW-040–042).
 * Read-only. Heuristic overlap/gap evidence is VERIFY-grade unless state is definitive.
 */

import { githubJson, GithubIssue } from '../lib/github.js';
import { lsRemoteHeads } from '../lib/git.js';
import {
  createContentionBudget,
  provenanceFooter,
  DEFAULT_CONTENTION_BUDGET_BYTES
} from '../lib/contention-budget.js';
import {
  extractTouchedPaths,
  extractTouchedSymbols,
  fetchPullDiff
} from '../lib/github-diff.js';
import {
  ContentionReportSchema,
  type ContentionClaim,
  type ContentionReport,
  type ContentionState
} from '../contracts/contention.js';
import { createEnvelope, type Envelope } from './envelope.js';
import { linked_work } from './linked-work.js';
import { buildEquivalenceClasses, claimsSuperseded } from './diff-overlap.js';
import { analyzeGaps } from './gap-analysis.js';
import { assessSwarmRisk } from './swarm-risk.js';

export type ContentionInput = {
  repo: string;
  issue_number: number;
  /** When false, skip PR diff fetches (P0-only path). Default true. */
  include_diffs?: boolean;
  /** When false, skip gap + swarm (P0/P1 without P2). Default true. */
  include_gaps?: boolean;
  budget_bytes?: number;
  draft_diff?: string;
};

export type ContentionResult = Envelope & {
  contention: ContentionReport;
};

type LinkedPrEvidence = {
  kind: string;
  number: number;
  state: string;
  draft?: boolean;
  merged?: boolean;
  date: string;
  updated_at?: string;
  author: string | null;
  title: string;
  url: string;
  source: string;
  repo?: string;
  closes_issue?: boolean;
  ignored_reason?: string;
  closed_at?: string | null;
};

export async function contention(input: ContentionInput): Promise<ContentionResult> {
  const includeDiffs = input.include_diffs !== false;
  const includeGaps = input.include_gaps !== false;
  const budget = createContentionBudget(input.budget_bytes ?? DEFAULT_CONTENTION_BUDGET_BYTES);

  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const issueText = `${issue.title}\n${issue.body ?? ''}`;
  const issueBytes = Buffer.byteLength(issueText, 'utf8');
  const labels = (issue.labels ?? []).map((label) => label.name);

  const linked = await linked_work({ repo: input.repo, issue_number: input.issue_number });
  const linkedPrs = (linked.evidence as LinkedPrEvidence[]).filter((item) => item.kind === 'linked_pr' && !item.ignored_reason);

  const claims: ContentionClaim[] = [];
  for (const pr of linkedPrs) {
    const repo = pr.repo ?? input.repo;
    const claim: ContentionClaim = {
      pr: pr.number,
      repo,
      state: pr.state === 'open' ? 'open' : 'closed',
      draft: pr.draft === true,
      merged: pr.merged === true,
      author: pr.author,
      title: pr.title,
      url: pr.url,
      created_at: toIso(pr.date),
      updated_at: pr.updated_at ? toIso(pr.updated_at) : undefined,
      closed_at: pr.closed_at ? toIso(pr.closed_at) : null,
      source: mapSource(pr.source),
      closes_issue: pr.closes_issue === true,
      touched_paths: [],
      touched_symbols: []
    };

    if (includeDiffs) {
      try {
        const diff = await fetchPullDiff(repo, pr.number, budget);
        claim.diff_stat = {
          additions: diff.additions,
          deletions: diff.deletions,
          changed_files: diff.changed_files,
          bytes: diff.bytes,
          truncated: diff.truncated
        };
        claim.touched_paths = extractTouchedPaths(diff.text);
        claim.touched_symbols = extractTouchedSymbols(diff.text);
      } catch {
        claim.diff_stat = { truncated: true };
      }
    }
    claims.push(claim);
  }

  // C1 source 3: head-branch names containing the issue number (density evidence only —
  // claims require a PR number; branch hits without a PR stay in checked/not_checked).
  let claimBranches: string[] = [];
  try {
    const heads = await lsRemoteHeads(input.repo);
    const needle = String(input.issue_number);
    claimBranches = heads.map((head) => head.name).filter((name) => name.includes(needle)).slice(0, 20);
  } catch {
    // branch scan is best-effort supplemental
  }

  const classes = includeDiffs ? buildEquivalenceClasses(claims) : claims.map((claim, index) => ({
    id: `eq-${index + 1}`,
    relation: 'distinct' as const,
    prs: [claim.pr],
    representative: claim.pr,
    shared_paths: [] as string[],
    shared_symbols: [] as string[],
    low_confidence: true,
    note: 'diff comparison skipped'
  }));

  const state = resolveState(claims, classes, includeDiffs);
  const draft = input.draft_diff
    ? {
      paths: extractTouchedPaths(input.draft_diff),
      symbols: extractTouchedSymbols(input.draft_diff)
    }
    : undefined;

  const gaps = includeGaps
    ? analyzeGaps({
      issueTitle: issue.title,
      issueBody: issue.body,
      labels,
      claims,
      classes,
      draft
    })
    : [];

  const swarm = assessSwarmRisk({
    issueBody: issue.body,
    labels,
    issueCreatedAt: issue.created_at,
    claimCount: claims.length
  });

  const footer = provenanceFooter({
    claimCount: claims.length,
    issueBytes,
    discussionBytes: 0,
    commentCount: 0,
    verdictCount: 1 + classes.length + gaps.length,
    budget
  });

  const report = ContentionReportSchema.parse({
    contention_version: 1,
    state,
    claims,
    equivalence_classes: classes,
    gaps,
    swarm_risk: swarm.swarm_risk,
    posture: swarm.posture,
    provenance: {
      bytes_read: budget.usedBytes,
      artifacts_read: budget.artifactsRead,
      truncated: budget.truncated,
      verdict_count: 1 + classes.length + gaps.length,
      budget_bytes: budget.budgetBytes,
      footer
    },
    low_confidence: budget.truncated || classes.some((item) => item.low_confidence)
  });

  const representative = classes.find((item) => item.prs.length > 1)?.representative
    ?? claims.find((claim) => claim.state === 'open' && claim.closes_issue)?.pr
    ?? claims.find((claim) => claim.state === 'open')?.pr;

  const summary = formatSummary({
    issueNumber: input.issue_number,
    state,
    claims,
    classes,
    gaps,
    representative,
    swarm
  });

  const envelope = createEnvelope({
    verdict_summary: summary,
    evidence: [
      {
        kind: 'contention',
        ...report
      },
      ...(claimBranches.length > 0
        ? [{ kind: 'claim_branches', branches: claimBranches, note: 'branch names containing the issue number; not PR claims by themselves' }]
        : [])
    ],
    signals: signalsForState(state),
    checked: [
      `loaded issue ${input.repo}#${input.issue_number}`,
      'enumerated linked PR claims via linked_work',
      ...(claimBranches.length > 0 ? [`found ${claimBranches.length} remote head(s) whose name contains #${input.issue_number}`] : ['checked remote heads for issue-numbered branch names']),
      ...(includeDiffs ? ['fetched claiming PR diffs under byte budget'] : ['skipped PR diff fetches']),
      ...(includeGaps ? ['ran gap analysis and swarm-risk heuristics'] : [])
    ],
    not_checked: [
      ...linked.not_checked,
      ...(includeDiffs
        ? ['diff symbol extraction uses hunk-header heuristics (no tree-sitter); same-change is VERIFY-grade.']
        : ['diff-level dedup was not checked because include_diffs=false.']),
      'does not post review comments or mutate the tracker.',
      ...(budget.truncated ? ['byte budget truncated one or more diffs; overlapping verdicts may be low_confidence.'] : [])
    ],
    cached: false
  });

  return { ...envelope, contention: report };
}

function resolveState(
  claims: ContentionClaim[],
  classes: ReturnType<typeof buildEquivalenceClasses>,
  includeDiffs: boolean
): ContentionState {
  const open = claims.filter((claim) => claim.state === 'open' && !claim.merged);
  const mergedClosers = claims.filter((claim) => claim.merged && claim.closes_issue);
  // Only fully resolved when a merged closer exists and no open claims remain (drafts count).
  if (mergedClosers.length > 0 && open.length === 0) return 'resolved';
  if (includeDiffs && claimsSuperseded(claims, classes)) return 'superseded';
  if (open.length >= 2) return 'contested';
  if (open.length === 1 && claims.some((claim) => claim.state === 'closed' && !claim.merged)) {
    return includeDiffs && claimsSuperseded(claims, classes) ? 'superseded' : 'contested';
  }
  if (mergedClosers.length > 0 && open.length > 0) return 'contested';
  if (open.length === 0 && claims.some((claim) => claim.state === 'closed' && !claim.merged)) return 'uncontested';
  return open.length <= 1 ? 'uncontested' : 'contested';
}

function formatSummary(input: {
  issueNumber: number;
  state: ContentionState;
  claims: ContentionClaim[];
  classes: ReturnType<typeof buildEquivalenceClasses>;
  gaps: ContentionReport['gaps'];
  representative?: number;
  swarm: ReturnType<typeof assessSwarmRisk>;
}): string {
  const open = input.claims.filter((claim) => claim.state === 'open');
  const lines = [
    `#${input.issueNumber} — ${input.state} (${input.claims.length} claims, ${input.classes.length} equivalence classes)`
  ];
  if (input.representative) {
    const rep = input.claims.find((claim) => claim.pr === input.representative);
    const stat = rep?.diff_stat;
    const size = stat ? ` (+${stat.additions ?? '?'}/-${stat.deletions ?? '?'})` : '';
    lines.push(`  representative: #${input.representative}${size}`);
  }
  if (input.gaps.length === 0) lines.push('  gaps: none detected (heuristic)');
  else {
    lines.push('  gaps:');
    for (const gap of input.gaps.slice(0, 5)) lines.push(`    - ${gap.summary}`);
  }
  lines.push(`  swarm_risk: ${input.swarm.swarm_risk} → posture ${input.swarm.posture}`);
  if (open.length === 0) lines.push('  open claims: none');
  return lines.join('\n');
}

function signalsForState(state: ContentionState): Array<'linked_pr_open' | 'linked_pr_merged' | 'linked_pr_closed'> {
  if (state === 'resolved') return ['linked_pr_merged'];
  if (state === 'contested' || state === 'superseded') return ['linked_pr_open'];
  return [];
}

function mapSource(source: string): ContentionClaim['source'] {
  if (source === 'timeline' || source === 'search' || source === 'comment' || source === 'title_overlap') return source;
  return 'timeline';
}

function toIso(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date().toISOString();
}
