/**
 * Bounded two-stage PR opportunity scan (GW-046).
 * Cheap inventory → rank → enrich top N. Reuses contention/diff/gap helpers.
 * Does not call CLI/MCP surfaces.
 */

import { githubJson } from '../lib/github.js';
import { fetchPullDiff, extractTouchedPaths } from '../lib/github-diff.js';
import { createContentionBudget } from '../lib/contention-budget.js';
import { getActiveRunBudget, noteCandidatesConsidered } from '../lib/run-budget.js';
import { isAutomationAuthor } from './bots.js';
import { closesIssue } from './linkage.js';
import { contention } from './contention.js';
import {
  PR_ENRICH_LIMIT,
  PR_INVENTORY_LIMIT,
  PrScanFilterSchema,
  PrScanResultSchema,
  type PrEnrichment,
  type PrHintMode,
  type PrInventoryItem,
  type PrOpportunity,
  type PrScanFilter,
  type PrScanResult
} from '../contracts/pr-scan.js';

export type PrScanInput = {
  repo: string;
  include_bots?: boolean;
  include_merged?: boolean;
  include_drafts?: boolean;
  include_generated?: boolean;
  stale_pr_days?: number;
  inventory_limit?: number;
  enrich_limit?: number;
};

type GithubPullListItem = {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  created_at: string;
  updated_at: string;
  html_url?: string;
  user?: { login?: string } | null;
  labels?: Array<{ name?: string }>;
  head?: { sha?: string };
};

type GithubPullDetail = GithubPullListItem & {
  additions?: number;
  deletions?: number;
  changed_files?: number;
  merged?: boolean;
};

type GithubReview = {
  state?: string;
  user?: { login?: string } | null;
  author_association?: string;
};

type GithubIssueLite = {
  state?: string;
  number?: number;
};

type GithubCheckRuns = {
  check_runs?: Array<{ conclusion?: string | null; status?: string }>;
};

const GENERATED_TITLE = /^\s*(\[bot(?:\s+pr)?\]|chore\(deps\)|bump\s+|deps:\s+)/i;
const BUG_HINT = /\b(bug|fix|crash|regression|error|fail(?:s|ed|ing)?)\b/i;
const PLATFORM_HINT = /\b(windows|linux|macos|osx|wsl|docker|container)\b/i;
const MAINTAINER_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const CLOSING_ISSUE = /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/gi;

function ageDays(iso: string, now = Date.now()): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((now - parsed) / (24 * 60 * 60 * 1000)));
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)/i.test(path)
    || /\.(test|spec)\.[a-z]+$/i.test(path)
    || /_test\.[a-z]+$/i.test(path);
}

export function extractLinkedIssueNumber(title: string, body?: string | null): number | undefined {
  const text = `${title}\n${body ?? ''}`;
  const matches = [...text.matchAll(CLOSING_ISSUE)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : undefined;
}

export function isGeneratedPr(title: string, labels: string[] = []): boolean {
  if (GENERATED_TITLE.test(title)) return true;
  return labels.some((label) => /dependencies|deps|automation/.test(label.toLowerCase()));
}

export function filterInventoryReason(
  item: {
    author: string | null;
    merged: boolean;
    draft: boolean;
    title: string;
    labels?: string[];
  },
  filters: PrScanFilter
): string | undefined {
  if (!filters.include_bots && isAutomationAuthor(item.author)) return 'automation_author';
  if (!filters.include_merged && item.merged) return 'closed_merged';
  if (!filters.include_drafts && item.draft) return 'draft';
  if (!filters.include_generated && isGeneratedPr(item.title, item.labels)) return 'generated';
  return undefined;
}

export function cheapRankScore(item: {
  draft: boolean;
  merged: boolean;
  state: 'open' | 'closed';
  updated_at: string;
  linked_issue_number?: number;
  title: string;
  changed_files?: number;
}): number {
  let score = 0.45;
  if (item.state === 'open') score += 0.2;
  if (item.linked_issue_number) score += 0.15;
  if (!item.draft) score += 0.08;
  if (BUG_HINT.test(item.title)) score += 0.07;
  if (item.merged) score -= 0.3;
  const days = ageDays(item.updated_at);
  if (days <= 7) score += 0.08;
  else if (days >= 60) score -= 0.08;
  if (typeof item.changed_files === 'number' && item.changed_files > 80) score -= 0.1;
  return Math.max(0, Math.min(1, score));
}

function enrichmentDefaults(input: Partial<PrEnrichment> = {}): PrEnrichment {
  return {
    closes_issue: false,
    review_states: [],
    maintainer_reviewed: false,
    maintainer_positive_review: false,
    requested_changes: false,
    approved: false,
    ci_state: 'unknown',
    touched_paths: [],
    has_tests: false,
    competing_closers: 0,
    contention_gaps: [],
    stale: false,
    maintainer_interest: false,
    substantive: false,
    credible_work: false,
    healthy_active: false,
    looks_like_bug: false,
    cross_platform: false,
    enormous_refactor: false,
    ...input
  };
}

export function classifyPrHint(enrichmentInput: Partial<PrEnrichment>, inventory: Pick<PrInventoryItem, 'draft' | 'state' | 'merged'>): {
  hint_mode: PrHintMode;
  hint_reasons: string[];
  hard_constraints: string[];
} {
  const enrichment = enrichmentDefaults(enrichmentInput);
  const reasons: string[] = [];
  const constraints: string[] = [];

  if (inventory.merged) {
    return { hint_mode: 'PASS', hint_reasons: ['Merged PRs are not contribution opportunities.'], hard_constraints: [] };
  }

  const salvageStrong = (
    (inventory.state === 'closed' && enrichment.substantive && enrichment.issue_open === true && enrichment.maintainer_positive_review)
    || (inventory.state === 'open' && enrichment.stale && enrichment.maintainer_interest && enrichment.credible_work
      && (enrichment.requested_changes || enrichment.maintainer_positive_review)
      && enrichment.issue_open !== false)
  );
  const salvageWeakOnly = enrichment.stale && !enrichment.maintainer_interest && !enrichment.requested_changes && !enrichment.maintainer_positive_review;

  if (salvageStrong) {
    constraints.push('coordinate_before_upstream_action', 'preserve_attribution', 'verify_current_main');
    reasons.push('Credible stalled implementation with maintainer engagement; salvage has a higher bar than age.');
    return { hint_mode: 'SALVAGE', hint_reasons: reasons, hard_constraints: constraints };
  }

  if (enrichment.healthy_active) {
    reasons.push('Active PR looks healthy; watch until CI, review, or ownership changes.');
    return { hint_mode: 'WATCH', hint_reasons: reasons, hard_constraints: [] };
  }

  if (salvageWeakOnly || (enrichment.stale && inventory.draft && !enrichment.maintainer_interest)) {
    reasons.push('Age or inactivity alone is not abandonment; inspect before salvage.');
    return { hint_mode: 'REVIEW', hint_reasons: reasons, hard_constraints: [] };
  }

  let reviewScore = 0.4;
  if (enrichment.looks_like_bug) { reviewScore += 0.12; reasons.push('Looks like a real bug.'); }
  if (!enrichment.maintainer_reviewed) { reviewScore += 0.1; reasons.push('No maintainer review yet.'); }
  if (enrichment.competing_closers > 1) { reviewScore += 0.12; reasons.push('Competing closers need internal review.'); }
  if (enrichment.ci_state === 'failure' || enrichment.ci_state === 'pending') { reviewScore += 0.08; reasons.push('CI is ambiguous or failing.'); }
  if (!enrichment.has_tests) { reviewScore += 0.06; reasons.push('No test paths in the diff.'); }
  if (enrichment.contention_gaps.length > 0) { reviewScore += 0.1; reasons.push('Contention gaps remain.'); }
  if (enrichment.requested_changes) { reviewScore += 0.08; reasons.push('Requested changes are outstanding.'); }
  if (enrichment.cross_platform) { reviewScore += 0.05; reasons.push('Cross-platform surface.'); }

  if (enrichment.healthy_active) reviewScore -= 0.2;
  if (enrichment.enormous_refactor) { reviewScore -= 0.12; reasons.push('Enormous refactor; review value is lower.'); }
  if (enrichment.approved && enrichment.ci_state === 'success') { reviewScore -= 0.15; reasons.push('Already approved and awaiting merge.'); }

  if (reviewScore < 0.35 && inventory.state === 'open' && !enrichment.stale) {
    reasons.push('Open PR without a high-value review gap; watch for state change.');
    return { hint_mode: 'WATCH', hint_reasons: reasons, hard_constraints: [] };
  }

  reasons.push('Internal review/evidence is the justified contribution; do not post review comments automatically.');
  return { hint_mode: 'REVIEW', hint_reasons: reasons, hard_constraints: [] };
}

function toInventory(repo: string, pr: GithubPullListItem, filters: PrScanFilter): PrInventoryItem {
  const author = pr.user?.login ?? null;
  const labels = (pr.labels ?? []).map((label) => label.name ?? '').filter(Boolean);
  const merged = Boolean(pr.merged_at);
  const state: 'open' | 'closed' = pr.state === 'open' ? 'open' : 'closed';
  const linked = extractLinkedIssueNumber(pr.title, pr.body);
  const item: Omit<PrInventoryItem, 'cheap_rank' | 'filtered_reason'> & { cheap_rank: number } = {
    target: {
      kind: 'pull_request' as const,
      repo,
      pr_number: pr.number,
      ...(linked ? { linked_issue_number: linked } : {})
    },
    repo,
    number: pr.number,
    title: pr.title,
    author,
    draft: pr.draft === true,
    state,
    merged,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    ...(linked ? { linked_issue_number: linked } : {}),
    cheap_rank: 0
  };
  const filtered = filterInventoryReason({ ...item, labels }, filters);
  return {
    ...item,
    cheap_rank: cheapRankScore(item),
    ...(filtered ? { filtered_reason: filtered } : {})
  };
}

function looksLikeBug(title: string, labels: string[]): boolean {
  return BUG_HINT.test(title) || labels.some((label) => /bug|regression/.test(label.toLowerCase()));
}

async function enrichOne(
  repo: string,
  item: PrInventoryItem,
  filters: PrScanFilter,
  checked: string[],
  notChecked: string[]
): Promise<PrEnrichment> {
  const detail = await githubJson<GithubPullDetail>(`/repos/${repo}/pulls/${item.number}`);
  checked.push(`pull_detail#${item.number}`);
  const labels = (detail.labels ?? []).map((label) => label.name ?? '').filter(Boolean);
  const linked = item.linked_issue_number ?? extractLinkedIssueNumber(detail.title, detail.body);
  const closes = linked ? closesIssue(`${detail.title}\n${detail.body ?? ''}`, linked) : false;

  let reviews: GithubReview[] = [];
  try {
    reviews = await githubJson<GithubReview[]>(`/repos/${repo}/pulls/${item.number}/reviews`);
    checked.push(`pull_reviews#${item.number}`);
  } catch {
    notChecked.push(`reviews unavailable for #${item.number}`);
  }

  const maintainerReviews = reviews.filter((review) => MAINTAINER_ASSOC.has(review.author_association ?? ''));
  const reviewStates = reviews.map((review) => review.state ?? 'UNKNOWN');
  const requestedChanges = reviewStates.includes('CHANGES_REQUESTED');
  const approved = reviewStates.includes('APPROVED');
  const maintainerPositive = maintainerReviews.some((review) => review.state === 'APPROVED' || review.state === 'COMMENTED');

  let ciState: PrEnrichment['ci_state'] = 'unknown';
  const sha = detail.head?.sha;
  if (sha) {
    try {
      const checks = await githubJson<GithubCheckRuns>(`/repos/${repo}/commits/${sha}/check-runs`);
      checked.push(`check_runs#${item.number}`);
      const runs = checks.check_runs ?? [];
      if (runs.some((run) => run.conclusion === 'failure' || run.conclusion === 'timed_out')) ciState = 'failure';
      else if (runs.some((run) => run.status === 'in_progress' || run.status === 'queued')) ciState = 'pending';
      else if (runs.length > 0 && runs.every((run) => run.conclusion === 'success' || run.conclusion === 'skipped' || run.conclusion === 'neutral')) {
        ciState = 'success';
      }
    } catch {
      notChecked.push(`CI unavailable for #${item.number}`);
    }
  }

  let touched: string[] = [];
  let hasTests = false;
  try {
    const budget = createContentionBudget();
    const diff = await fetchPullDiff(repo, item.number, budget);
    touched = extractTouchedPaths(diff.text);
    hasTests = touched.some((path) => isTestPath(path));
    checked.push(`pull_diff#${item.number}`);
  } catch {
    notChecked.push(`diff unavailable for #${item.number}`);
  }

  let issueOpen: boolean | undefined;
  let competing = 0;
  const gaps: string[] = [];
  if (linked) {
    try {
      const issue = await githubJson<GithubIssueLite>(`/repos/${repo}/issues/${linked}`);
      issueOpen = issue.state !== 'closed';
      checked.push(`linked_issue#${linked}`);
    } catch {
      notChecked.push(`linked issue #${linked} unavailable`);
    }
    try {
      const report = await contention({ repo, issue_number: linked, include_diffs: true, include_gaps: true });
      competing = report.contention.claims.filter((claim) => claim.state === 'open' && claim.closes_issue).length;
      gaps.push(...report.contention.gaps.map((gap) => gap.kind));
      checked.push(`contention#${linked}`);
    } catch {
      notChecked.push(`contention unavailable for issue #${linked}`);
    }
  }

  const staleDays = ageDays(item.updated_at);
  const stale = staleDays >= filters.stale_pr_days;
  const additions = detail.additions ?? 0;
  const deletions = detail.deletions ?? 0;
  const changed = detail.changed_files ?? item.changed_files ?? touched.length;
  const substantive = changed >= 3 || (additions + deletions) >= 20;
  const credible = substantive && !item.draft && (maintainerPositive || requestedChanges || Boolean(linked));
  const healthy = item.state === 'open'
    && !stale
    && !requestedChanges
    && maintainerReviews.length > 0
    && ciState === 'success'
    && gaps.length === 0
    && competing <= 1;

  return {
    linked_issue_number: linked,
    issue_open: issueOpen,
    closes_issue: closes,
    review_states: reviewStates,
    maintainer_reviewed: maintainerReviews.length > 0,
    maintainer_positive_review: maintainerPositive,
    requested_changes: requestedChanges,
    approved,
    ci_state: ciState,
    additions: detail.additions,
    deletions: detail.deletions,
    changed_files: changed,
    touched_paths: touched,
    has_tests: hasTests,
    competing_closers: competing,
    contention_gaps: gaps,
    stale,
    stale_days: staleDays,
    maintainer_interest: maintainerReviews.length > 0 || requestedChanges,
    substantive,
    credible_work: credible,
    healthy_active: healthy,
    looks_like_bug: looksLikeBug(item.title, labels),
    cross_platform: PLATFORM_HINT.test(`${item.title}\n${detail.body ?? ''}`),
    enormous_refactor: changed >= 80 || (additions + deletions) >= 1500
  };
}

/** Two-stage PR scan: cheap inventory, then enrich at most 5 ranked candidates. */
export async function pr_scan(input: PrScanInput): Promise<PrScanResult> {
  const filters = PrScanFilterSchema.parse({
    ...(input.include_bots !== undefined ? { include_bots: input.include_bots } : {}),
    ...(input.include_merged !== undefined ? { include_merged: input.include_merged } : {}),
    ...(input.include_drafts !== undefined ? { include_drafts: input.include_drafts } : {}),
    ...(input.include_generated !== undefined ? { include_generated: input.include_generated } : {}),
    ...(input.stale_pr_days !== undefined ? { stale_pr_days: input.stale_pr_days } : {}),
    ...(input.inventory_limit !== undefined ? { inventory_limit: input.inventory_limit } : {}),
    ...(input.enrich_limit !== undefined ? { enrich_limit: input.enrich_limit } : {})
  });
  const inventoryLimit = Math.min(filters.inventory_limit, PR_INVENTORY_LIMIT);
  const enrichLimit = Math.min(filters.enrich_limit, PR_ENRICH_LIMIT);
  const checked: string[] = [`listed pull requests for ${input.repo}`];
  const notChecked: string[] = [
    'PR scan does not clone the repository.',
    'CLI/MCP wiring is deferred to the portfolio integration slice.'
  ];

  const listed = await githubJson<GithubPullListItem[]>(
    `/repos/${input.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${inventoryLimit}`
  );
  noteCandidatesConsidered(listed.length);

  const inventory = listed.map((pr) => toInventory(input.repo, pr, filters));
  const kept = inventory.filter((item) => !item.filtered_reason);
  const ranked = [...kept].sort((left, right) => right.cheap_rank - left.cheap_rank || right.number - left.number);
  const toEnrich = ranked.slice(0, enrichLimit);

  const opportunities: PrOpportunity[] = [];
  let budgetTruncated = false;
  const activeBudget = getActiveRunBudget();

  for (const item of ranked) {
    const shouldEnrich = toEnrich.some((row) => row.number === item.number);
    if (!shouldEnrich) {
      const classified = classifyPrHint({
        closes_issue: Boolean(item.linked_issue_number),
        stale: ageDays(item.updated_at) >= filters.stale_pr_days
      }, item);
      opportunities.push({
        target: item.target,
        inventory: item,
        enriched: false,
        hint_mode: item.state === 'closed' && !item.merged ? 'REVIEW' : classified.hint_mode,
        hint_reasons: item.state === 'closed' && !item.merged
          ? ['Closed unmerged PR was not enriched; treat as REVIEW until salvage evidence exists.']
          : classified.hint_reasons,
        hard_constraints: []
      });
      continue;
    }
    if (activeBudget?.counters.exhausted) {
      budgetTruncated = true;
      notChecked.push(`enrichment skipped for #${item.number} after run-budget exhaustion`);
      opportunities.push({
        target: item.target,
        inventory: item,
        enriched: false,
        hint_mode: 'REVIEW',
        hint_reasons: ['Budget exhausted before enrichment; defaulting to REVIEW.'],
        hard_constraints: []
      });
      continue;
    }
    try {
      const enrichment = await enrichOne(input.repo, item, filters, checked, notChecked);
      const classified = classifyPrHint(enrichment, item);
      opportunities.push({
        target: item.target,
        inventory: { ...item, changed_files: enrichment.changed_files, ci_state: enrichment.ci_state },
        enriched: true,
        enrichment,
        hint_mode: classified.hint_mode,
        hint_reasons: classified.hint_reasons,
        hard_constraints: classified.hard_constraints,
        salvage_facts: {
          substantive_prior_attempt: enrichment.substantive && item.state === 'closed' && !item.merged,
          stale_open_pr: item.state === 'open' && enrichment.stale,
          maintainer_interest: enrichment.maintainer_interest,
          credible_work_remains: enrichment.credible_work,
          healthy_active_closer: enrichment.healthy_active && enrichment.closes_issue,
          issue_open: enrichment.issue_open
        }
      });
    } catch (error) {
      notChecked.push(`enrichment failed for #${item.number}: ${error instanceof Error ? error.message : String(error)}`);
      opportunities.push({
        target: item.target,
        inventory: item,
        enriched: false,
        hint_mode: 'REVIEW',
        hint_reasons: ['Enrichment failed; defaulting to REVIEW.'],
        hard_constraints: []
      });
    }
  }

  return PrScanResultSchema.parse({
    pr_scan_version: 1,
    repo: input.repo,
    inventory_count: listed.length,
    filtered_count: inventory.length - kept.length,
    enriched_count: opportunities.filter((item) => item.enriched).length,
    budget_truncated: budgetTruncated,
    opportunities,
    checked,
    not_checked: notChecked
  });
}
