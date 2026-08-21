/**
 * Contribution portfolio (GW-047): hunt + PR scan + capacity, without mutating verdicts.
 */

import { GitworthyError, createEnvelope, type Envelope } from './envelope.js';
import { hunt } from './hunt.js';
import { pr_scan } from './pr-scan.js';
import { GENERIC_CONTRIBUTION_PROFILE, matchDomains, parseContributionProfile } from './contribution-profile.js';
import { scoreOpportunity } from './opportunity-score.js';
import { routeContribution } from '../decision/contribution-route.js';
import { listOutcomes } from '../lib/store-query.js';
import { getActiveRunBudget } from '../lib/run-budget.js';
import { PR_ENRICH_LIMIT, PR_INVENTORY_LIMIT } from '../contracts/pr-scan.js';
import type { OutcomeEvent } from '../contracts/outcomes.js';
import type { ContributionMode, RoutingDecision, RouteFacts } from '../contracts/routing.js';
import type { ContributionProfile } from '../contracts/contribution-profile.js';
import type { OpportunityTarget } from '../contracts/opportunities.js';
import type { PrOpportunity } from '../contracts/pr-scan.js';
import {
  PortfolioItemSchema,
  type DispatchState,
  type PortfolioCapacity,
  type PortfolioItem
} from '../contracts/portfolio.js';

/** Org portfolio fans out PR scans to at most this many hunt repos (not every org repo). */
export const ORG_PR_SCAN_REPO_CAP = 5;

const ACTIVE_EVENTS = new Set(['selected', 'patch_started', 'pr_opened']);
const TERMINAL_EVENTS = new Set([
  'merged',
  'closed_unmerged',
  'rejected',
  'abandoned',
  'duplicate_confirmed',
  'already_fixed_confirmed',
  'maintainer_redirected'
]);

export type PortfolioInput = {
  repo?: string;
  org?: string;
  label?: string;
  keywords?: string[];
  since?: string;
  scan_limit?: number;
  max_repos?: number;
  max_checks?: number;
  max_items?: number;
  include_watch?: boolean;
  include_prs?: boolean;
  skill_profile?: string | { languages?: string[]; topics?: string[] };
  contribution_profile?: unknown;
};

export type PortfolioDeps = {
  hunt?: typeof hunt;
  pr_scan?: typeof pr_scan;
  listOutcomes?: typeof listOutcomes;
  listWatch?: () => Promise<unknown[]>;
};

export type PortfolioResult = Envelope & {
  command: 'portfolio';
  items: PortfolioItem[];
  capacity: PortfolioCapacity;
};

type HuntCandidate = {
  kind?: string;
  status?: string;
  repo?: string;
  issue_number?: number;
  title?: string;
  worth_check?: {
    verdict?: string;
    disposition?: string;
    findings?: Array<{ type?: string; strength?: string; message?: string }>;
    routing?: RoutingDecision;
    next_actions?: Array<{ kind?: string; message?: string }>;
  };
};

function targetKey(repo: string, issue: number): string {
  return `${repo}#${issue}`;
}

export function computeCapacity(
  events: OutcomeEvent[],
  profile: ContributionProfile
): PortfolioCapacity {
  const byTarget = new Map<string, OutcomeEvent[]>();
  for (const event of events) {
    const key = targetKey(event.target.repo, event.target.issue_number);
    const list = byTarget.get(key) ?? [];
    list.push(event);
    byTarget.set(key, list);
  }
  const used: Record<string, number> = {};
  const reasons: string[] = [];
  let missingMode = 0;
  for (const [key, list] of byTarget) {
    const ordered = [...list].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
    const lastTerminal = [...ordered].reverse().find((event) => TERMINAL_EVENTS.has(event.event));
    const lastActive = [...ordered].reverse().find((event) => ACTIVE_EVENTS.has(event.event));
    if (!lastActive) continue;
    if (lastTerminal && lastTerminal.occurred_at >= lastActive.occurred_at) continue;
    const modeRaw = lastActive.data.contribution_mode;
    const mode = typeof modeRaw === 'string' ? modeRaw : 'BUILD';
    if (typeof modeRaw !== 'string') {
      missingMode += 1;
      reasons.push(`${key} counts as BUILD because the active outcome has no contribution_mode`);
    }
    used[mode] = (used[mode] ?? 0) + 1;
  }
  const limits: Record<string, number> = {};
  for (const [mode, limit] of Object.entries(profile.wip_limits)) {
    if (typeof limit === 'number') limits[mode] = limit;
  }
  return {
    used,
    limits,
    confidence: missingMode > 0 ? 'low' : events.length === 0 ? 'medium' : 'high',
    reasons
  };
}

function dispatchFor(
  mode: ContributionMode,
  capacity: PortfolioCapacity,
  blocked: boolean
): DispatchState {
  if (blocked) return 'blocked_by_constraint';
  if (mode === 'WATCH' || mode === 'PASS') return mode === 'WATCH' ? 'watching' : 'blocked_by_constraint';
  const limit = capacity.limits[mode];
  const used = capacity.used[mode] ?? 0;
  if (typeof limit === 'number' && used >= limit) return 'queued_by_capacity';
  return 'ready';
}

function findingsUnsafeForBuild(findings: Array<{ type?: string; strength?: string }>): boolean {
  return findings.some((item) => (
    (item.type === 'released_fix' && item.strength === 'definitive')
    || item.type === 'no_pr_path'
    || (item.type === 'linked_pr_open' && item.strength === 'definitive')
  ));
}

function applySafetyGate(
  item: PortfolioItem,
  findings: Array<{ type?: string; strength?: string }> = []
): PortfolioItem {
  const routing = item.routing;
  const mandatoryFailed = (routing?.coverage.failed_checks ?? []).some((check) => (
    check === 'linked_work' || check === 'contrib_policy' || check === 'issue_vs_main'
  ));
  const unsafe = findingsUnsafeForBuild(findings)
    || item.disposition === 'land_only'
    || item.disposition === 'blocked'
    || (routing?.hard_constraints ?? []).includes('suppress_build')
    || routing?.build_contention === 'RED';
  if (item.primary_mode !== 'BUILD') return item;
  if (unsafe) {
    const nextMode = item.disposition === 'blocked' ? 'PASS' : 'REVIEW';
    return {
      ...item,
      primary_mode: nextMode,
      dispatch_state: 'blocked_by_constraint',
      routing: routing ? { ...routing, primary_mode: nextMode, confidence: routing.confidence === 'high' ? 'medium' : routing.confidence } : routing,
      reasons: [...item.reasons, 'Safety gate blocked BUILD; verdict is unchanged.']
    };
  }
  if (mandatoryFailed && routing?.confidence === 'high') {
    return {
      ...item,
      primary_mode: 'REVIEW',
      dispatch_state: item.dispatch_state === 'queued_by_capacity' ? 'queued_by_capacity' : 'ready',
      routing: { ...routing, primary_mode: 'REVIEW', confidence: 'medium' },
      reasons: [...item.reasons, 'Mandatory check failure cannot keep a high-confidence BUILD.']
    };
  }
  return item;
}

function factsFromHunt(candidate: HuntCandidate): RouteFacts {
  const worth = candidate.worth_check;
  const findings = (worth?.findings ?? []).map((item, index) => ({
    id: `portfolio-${index + 1}`,
    type: item.type ?? 'unknown',
    strength: (item.strength === 'definitive' ? 'definitive' : 'heuristic') as 'definitive' | 'heuristic',
    effect: 'inform' as const,
    source: 'portfolio',
    message: item.message ?? 'finding',
    data: {}
  }));
  return {
    verdict: (worth?.verdict === 'ACT' || worth?.verdict === 'VERIFY' || worth?.verdict === 'SKIP')
      ? worth.verdict
      : 'VERIFY',
    disposition: (worth?.disposition === 'greenfield' || worth?.disposition === 'land_only'
      || worth?.disposition === 'claim_first' || worth?.disposition === 'blocked'
      || worth?.disposition === 'crowded' || worth?.disposition === 'review')
      ? worth.disposition
      : 'greenfield',
    findings,
    mandatoryFailures: [],
    linked: {
      activeClosers: findings.some((item) => item.type === 'linked_pr_open' && item.strength === 'definitive') ? 1 : 0,
      activeRelatedPrs: 0,
      closedUnmergedAttempts: findings.some((item) => item.type === 'linked_pr_closed') ? 1 : 0,
      mergedClosers: 0,
      assigned: findings.some((item) => item.type === 'assigned'),
      claimRequired: findings.some((item) => item.type === 'claim_required')
    },
    coverage: {
      mandatory_checks_complete: false,
      failed_checks: [],
      skipped_checks: ['embedded_routing_missing'],
      budget_truncated: false,
      rate_limit_degraded: false,
      advisory_missing: ['quality', 'contention']
    }
  };
}

function itemFromHunt(
  candidate: HuntCandidate,
  profile: ContributionProfile,
  capacity: PortfolioCapacity
): PortfolioItem | null {
  if (!candidate.repo || !candidate.issue_number) return null;
  if (candidate.status === 'failed' || !candidate.worth_check) return null;
  const routing = candidate.worth_check?.routing ?? routeContribution(factsFromHunt(candidate));
  const domain = matchDomains({ title: candidate.title }, profile);
  const scored = scoreOpportunity({
    mode: routing.primary_mode,
    impact: routing.primary_mode === 'PASS' ? 0.1 : 0.7,
    fit: domain.domain_fit_score || 0.5,
    evidenceability: routing.evidenceability.score,
    availability: routing.build_contention === 'GREEN' ? 0.9 : routing.build_contention === 'YELLOW' ? 0.5 : 0.2,
    domain_value: domain.domain_fit_score || 0.5,
    effort_bucket: routing.effort_bucket,
    hard_constraints: routing.hard_constraints,
    suppress_build: routing.build_contention === 'RED',
    profile
  });
  const verdict = candidate.worth_check?.verdict;
  const disposition = candidate.worth_check?.disposition;
  const target: OpportunityTarget = {
    kind: 'issue',
    repo: candidate.repo,
    issue_number: candidate.issue_number
  };
  const item: PortfolioItem = PortfolioItemSchema.parse({
    target,
    primary_mode: routing.primary_mode,
    dispatch_state: dispatchFor(routing.primary_mode, capacity, routing.primary_mode === 'PASS'),
    score: scored.score,
    ...(verdict === 'ACT' || verdict === 'VERIFY' || verdict === 'SKIP' ? { verdict } : {}),
    ...(disposition === 'greenfield' || disposition === 'land_only' || disposition === 'claim_first'
      || disposition === 'blocked' || disposition === 'crowded' || disposition === 'review'
      ? { disposition }
      : {}),
    routing,
    reasons: [...routing.reasons, ...scored.reasons],
    next_actions: (candidate.worth_check?.next_actions ?? routing.next_actions).map((action) => ({
      kind: action.kind ?? 'next',
      message: action.message ?? ''
    }))
  });
  return applySafetyGate(item, candidate.worth_check?.findings ?? []);
}

function itemFromPr(opportunity: PrOpportunity, profile: ContributionProfile, capacity: PortfolioCapacity): PortfolioItem {
  const mode = opportunity.hint_mode === 'PASS' ? 'PASS' : opportunity.hint_mode;
  const salvage = opportunity.salvage_facts;
  const routing = routeContribution({
    verdict: 'VERIFY',
    disposition: mode === 'WATCH' ? 'land_only' : 'review',
    findings: [],
    mandatoryFailures: [],
    linked: {
      activeClosers: salvage?.healthy_active_closer ? 1 : 0,
      activeRelatedPrs: 1,
      closedUnmergedAttempts: salvage?.substantive_prior_attempt ? 1 : 0,
      mergedClosers: 0,
      assigned: false,
      claimRequired: false,
      issueOpen: salvage?.issue_open,
      substantivePriorAttempt: salvage?.substantive_prior_attempt,
      staleOpenPr: salvage?.stale_open_pr,
      maintainerInterest: salvage?.maintainer_interest,
      credibleWorkRemains: salvage?.credible_work_remains,
      healthyActiveCloser: salvage?.healthy_active_closer
    },
    coverage: {
      mandatory_checks_complete: opportunity.enriched,
      failed_checks: [],
      skipped_checks: opportunity.enriched ? [] : ['pr_enrichment'],
      budget_truncated: false,
      rate_limit_degraded: false,
      advisory_missing: []
    }
  });
  const scored = scoreOpportunity({
    mode,
    impact: 0.55,
    fit: 0.6,
    evidenceability: opportunity.enriched ? 0.7 : 0.4,
    availability: mode === 'WATCH' ? 0.3 : 0.6,
    domain_value: 0.5,
    effort_bucket: 'medium',
    hard_constraints: opportunity.hard_constraints,
    profile
  });
  return applySafetyGate(PortfolioItemSchema.parse({
    target: opportunity.target,
    primary_mode: mode,
    dispatch_state: dispatchFor(mode, capacity, mode === 'PASS'),
    score: scored.score,
    routing: { ...routing, primary_mode: mode, hard_constraints: opportunity.hard_constraints },
    reasons: opportunity.hint_reasons,
    next_actions: mode === 'SALVAGE'
      ? [{ kind: 'coordinate', message: 'Coordinate before upstream salvage; preserve attribution.' }]
      : [{ kind: 'review', message: 'Inspect the PR internally; do not post review comments automatically.' }]
  }));
}

function diversify(items: PortfolioItem[], maxItems: number): PortfolioItem[] {
  const ranked = [...items].sort((left, right) => right.score - left.score);
  const cap = Math.max(1, Math.ceil(maxItems * 0.5));
  const counts: Record<string, number> = {};
  const picked: PortfolioItem[] = [];
  const deferred: PortfolioItem[] = [];
  for (const item of ranked) {
    const used = counts[item.primary_mode] ?? 0;
    if (used >= cap) {
      deferred.push(item);
      continue;
    }
    counts[item.primary_mode] = used + 1;
    picked.push(item);
    if (picked.length >= maxItems) return picked;
  }
  for (const item of deferred) {
    if (picked.length >= maxItems) break;
    picked.push(item);
  }
  return picked;
}

function reposForOrgPrScan(candidates: HuntCandidate[], maxRepos?: number): string[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.repo) continue;
    counts.set(candidate.repo, (counts.get(candidate.repo) ?? 0) + 1);
  }
  const cap = Math.min(ORG_PR_SCAN_REPO_CAP, Math.max(1, maxRepos ?? ORG_PR_SCAN_REPO_CAP));
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, cap)
    .map(([repo]) => repo);
}

async function scanPrsBounded(input: {
  repos: string[];
  profile: ContributionProfile;
  capacity: PortfolioCapacity;
  runPrScan: typeof pr_scan;
  checked: string[];
  notChecked: string[];
}): Promise<{ items: PortfolioItem[]; budgetTruncated: boolean }> {
  const items: PortfolioItem[] = [];
  let remainingInventory = PR_INVENTORY_LIMIT;
  let remainingEnrich = PR_ENRICH_LIMIT;
  let budgetTruncated = false;
  const perRepoInventory = Math.max(1, Math.floor(PR_INVENTORY_LIMIT / Math.max(1, input.repos.length)));

  for (const repo of input.repos) {
    const budget = getActiveRunBudget();
    if (budget?.counters.exhausted || remainingInventory <= 0) {
      budgetTruncated = true;
      input.notChecked.push(`PR scan skipped for ${repo} after inventory/budget cap.`);
      continue;
    }
    const inventoryLimit = Math.min(remainingInventory, perRepoInventory);
    const enrichLimit = remainingEnrich;
    try {
      const scan = await input.runPrScan({
        repo,
        stale_pr_days: input.profile.stale_pr_days,
        inventory_limit: inventoryLimit,
        enrich_limit: enrichLimit
      });
      remainingInventory -= scan.inventory_count;
      remainingEnrich -= scan.enriched_count;
      if (scan.budget_truncated) budgetTruncated = true;
      input.checked.push(`${repo} PR inventory ${scan.inventory_count}, enriched ${scan.enriched_count}`);
      for (const opportunity of scan.opportunities) {
        items.push(itemFromPr(opportunity, input.profile, input.capacity));
      }
    } catch (error) {
      input.notChecked.push(`PR scan failed for ${repo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (budgetTruncated) {
    input.notChecked.push('Org PR fan-out was partial or budget-degraded; inventory stays ≤25 and enrich ≤5.');
  }
  return { items, budgetTruncated };
}

/** Rank issue + PR opportunities without a global ACT/VERIFY/SKIP verdict. */
export async function portfolio(input: PortfolioInput, deps: PortfolioDeps = {}): Promise<PortfolioResult> {
  if (Boolean(input.repo) === Boolean(input.org)) {
    throw new GitworthyError({
      code: 'portfolio_invalid_input',
      message: 'portfolio requires exactly one of repo or org.',
      not_checked: ['portfolio requires exactly one of repo or org.']
    });
  }
  const profile = parseContributionProfile(input.contribution_profile) ?? GENERIC_CONTRIBUTION_PROFILE;
  const runHunt = deps.hunt ?? hunt;
  const runPrScan = deps.pr_scan ?? pr_scan;
  const loadOutcomes = deps.listOutcomes ?? listOutcomes;
  const checked = ['portfolio assembled issue hunt and optional PR scan'];
  const notChecked = [
    'Portfolio does not emit a global ACT/VERIFY/SKIP verdict.',
    'Routing never mutates worth_check verdicts.'
  ];
  const huntResult = await runHunt({
    repo: input.repo,
    org: input.org,
    label: input.label,
    keywords: input.keywords,
    since: input.since,
    scan_limit: input.scan_limit,
    max_repos: input.max_repos,
    max_checks: input.max_checks ?? 3,
    skill_profile: input.skill_profile
  });
  const candidates = (huntResult.evidence as HuntCandidate[]).filter((item) => item.kind === 'hunt_candidate');
  const huntRepos = new Set(
    candidates.map((item) => item.repo).filter((repo): repo is string => Boolean(repo))
  );
  if (input.repo) huntRepos.add(input.repo);
  const rawOutcomes = await loadOutcomes({ repo: input.repo, limit: 500 });
  const outcomes = input.repo
    ? rawOutcomes
    : rawOutcomes.filter((event) => huntRepos.has(event.target.repo));
  const capacity = computeCapacity(outcomes, profile);

  const items: PortfolioItem[] = [];
  for (const candidate of candidates) {
    const item = itemFromHunt(candidate, profile, capacity);
    if (item) items.push(item);
  }

  if (input.include_prs !== false) {
    const prRepos = input.repo ? [input.repo] : reposForOrgPrScan(candidates, input.max_repos);
    if (input.org && prRepos.length === 0) {
      notChecked.push('Org PR fan-out needs hunt candidate repos; none were present.');
    } else if (input.org) {
      const uniqueHuntRepos = new Set(candidates.map((item) => item.repo).filter((repo): repo is string => Boolean(repo)));
      if (uniqueHuntRepos.size > prRepos.length) {
        notChecked.push(`Org PR fan-out capped at ${prRepos.length} of ${uniqueHuntRepos.size} hunt repos (inventory ≤${PR_INVENTORY_LIMIT}, enrich ≤${PR_ENRICH_LIMIT}).`);
      }
    }
    if (prRepos.length > 0) {
      const scanned = await scanPrsBounded({
        repos: prRepos,
        profile,
        capacity,
        runPrScan,
        checked,
        notChecked
      });
      items.push(...scanned.items);
    }
  }

  if (input.include_watch) {
    const watch = deps.listWatch ? await deps.listWatch() : [];
    if (watch.length === 0) notChecked.push('Watch registry is empty or not wired until the watch slice.');
  }

  const maxItems = Math.max(1, input.max_items ?? 10);
  const selected = diversify(items, maxItems);
  const envelope = createEnvelope({
    verdict_summary: `portfolio ranked ${selected.length} opportunities; dispatch is separate from verdict.`,
    evidence: selected.map((item) => ({ ...item, url: undefined })),
    signals: [],
    checked,
    not_checked: notChecked
  });
  return {
    ...envelope,
    command: 'portfolio',
    items: selected,
    capacity
  };
}
