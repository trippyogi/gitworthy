import { branch_scan } from './branch-scan.js';
import { dupe_cluster } from './dupe-cluster.js';
import { issue_vs_main } from './issue-vs-main.js';
import { linked_work } from './linked-work.js';
import { release_gap } from './release-gap.js';
import { contrib_policy } from './contrib-policy.js';
import { createEnvelope, Envelope, GitworthyError, Signal } from './envelope.js';
import { distinctiveTerms } from './terms.js';
import { githubJson, GithubIssue } from '../lib/github.js';
import { upsertLedgerEntry } from '../lib/ledger.js';
import { stateFingerprint } from '../lib/state-fingerprint.js';
import { decideFromSignals, type Disposition } from '../decision/policy.js';
import { routeContribution } from '../decision/contribution-route.js';
import { assessIssueQuality } from './candidate-quality.js';
import type { Finding } from '../contracts/findings.js';
import type {
  RouteFacts,
  RouteLinkedFacts,
  RoutingCoverage,
  RoutingDecision,
  SourceSnapshot
} from '../contracts/routing.js';

type Input = { repo: string; issue_number: number; npm_package?: string; probe?: { file_glob?: string; contains?: string }; probe_template?: string };
type SubResult = { name: string; ok: true; result: Envelope } | { name: string; ok: false; error: { code: string; message: string; not_checked: string[] } };

export type { Disposition };

type WorthPerf = {
  short_circuited: boolean;
  clone_cached: boolean | null;
  file_list_cached: boolean | null;
  branch_tip_fetches: number | null;
  issue_vs_main_mode: string | null;
};

type WorthEnvelope = Envelope & {
  verdict: 'ACT' | 'VERIFY' | 'SKIP';
  disposition: Disposition;
  reasons: string[];
  sub_results: SubResult[];
  timings_ms: Record<string, number>;
  perf: WorthPerf;
  routing?: RoutingDecision;
  source_snapshot?: SourceSnapshot;
};

type IssueSnapshot = {
  state?: string;
  updated_at?: string;
  assignees: string[];
  title?: string;
  body?: string | null;
  labels: string[];
  comments?: number;
  created_at?: string;
};

function linkedDensity(subResults: SubResult[]): { priorAttempts: number; referencedCommits: number; networkPrs: number; openCloser: string | null } {
  const linked = subResults.find((result) => result.ok && result.name === 'linked_work');
  if (!linked?.ok) return { priorAttempts: 0, referencedCommits: 0, networkPrs: 0, openCloser: null };
  const prs = linked.result.evidence.filter((item) => item.kind === 'linked_pr' && item.ignored_reason !== 'automation_author');
  const priorAttempts = prs.filter((item) => item.prior_attempt === true || (item.state === 'closed' && item.merged !== true)).length;
  const referencedCommits = linked.result.evidence.filter((item) => item.kind === 'referenced_commit').length;
  const networkPrs = linked.result.evidence.filter((item) => item.kind === 'network_pr').length;
  const openWithCloses = prs.find((item) => item.state === 'open' && item.closes_issue === true);
  const openAny = prs.find((item) => item.state === 'open');
  const chosen = openWithCloses ?? openAny;
  const openCloser = chosen && typeof chosen.number === 'number'
    ? `#${chosen.number}${typeof chosen.url === 'string' ? ` ${chosen.url}` : ''}`
    : null;
  return { priorAttempts, referencedCommits, networkPrs, openCloser };
}

function err(name: string, error: unknown): SubResult {
  if (error instanceof GitworthyError) return { name, ok: false, error: { code: error.code, message: error.message, not_checked: error.not_checked } };
  return { name, ok: false, error: { code: 'unknown_error', message: error instanceof Error ? error.message : String(error), not_checked: ['sub-check failed with an unknown error.'] } };
}

async function runNamed(name: string, run: () => Promise<Envelope>): Promise<SubResult> {
  try {
    return { name, ok: true, result: await run() };
  } catch (error) {
    return err(name, error);
  }
}

function hasDefinitiveClosingOpenPr(subResults: SubResult[]): boolean {
  const linked = subResults.find((result) => result.ok && result.name === 'linked_work');
  if (!linked?.ok) return false;
  return linked.result.evidence.some((item) =>
    item.kind === 'linked_pr'
    && item.state === 'open'
    && item.closes_issue === true
    && item.source !== 'title_overlap'
    && item.ignored_reason !== 'automation_author'
  );
}

function extractPerf(subResults: SubResult[], shortCircuited: boolean): WorthPerf {
  const issueMain = subResults.find((result) => result.ok && result.name === 'issue_vs_main');
  const branch = subResults.find((result) => result.ok && result.name === 'branch_scan');
  const perfEvidence = issueMain?.ok
    ? issueMain.result.evidence.find((item) => item.kind === 'issue_vs_main_perf')
    : undefined;
  const tipFetches = branch?.ok
    ? branch.result.evidence.filter((item) => item.tip_fetched === true).length
    : null;
  return {
    short_circuited: shortCircuited,
    clone_cached: typeof perfEvidence?.clone_cached === 'boolean' ? perfEvidence.clone_cached : null,
    file_list_cached: typeof perfEvidence?.file_list_cached === 'boolean' ? perfEvidence.file_list_cached : null,
    branch_tip_fetches: tipFetches,
    issue_vs_main_mode: typeof perfEvidence?.mode === 'string' ? perfEvidence.mode : shortCircuited ? 'skipped' : null
  };
}

export function chooseDisposition(input: {
  verdict: 'ACT' | 'VERIFY' | 'SKIP';
  signals: Signal[];
  priorAttempts: number;
  referencedCommits: number;
  networkPrs?: number;
}): Disposition {
  return decideFromSignals({
    signals: input.signals,
    sub_results: [],
    errors: [],
    priorAttempts: input.priorAttempts,
    referencedCommits: input.referencedCommits,
    networkPrs: input.networkPrs ?? 0
  }).disposition;
}

function linkedPrEvidence(subResults: SubResult[]): Array<Record<string, unknown>> {
  const linked = subResults.find((result) => result.ok && result.name === 'linked_work');
  if (!linked?.ok) return [];
  return linked.result.evidence.filter((item) =>
    item.kind === 'linked_pr' && item.ignored_reason !== 'automation_author'
  );
}

function isExplicitCloser(item: Record<string, unknown>): boolean {
  return item.state === 'open'
    && item.closes_issue === true
    && item.source !== 'title_overlap'
    && !(item.draft === true && item.closes_issue !== true);
}

function buildLinkedFacts(subResults: SubResult[], findings: Finding[], issue?: IssueSnapshot): RouteLinkedFacts {
  const prs = linkedPrEvidence(subResults);
  const activeClosers = prs.filter((item) => isExplicitCloser(item));
  const activeRelated = prs.filter((item) => item.state === 'open' && !isExplicitCloser(item));
  const closedUnmerged = prs.filter((item) => item.state === 'closed' && item.merged !== true);
  const mergedClosers = prs.filter((item) => item.merged === true || item.state === 'merged');
  return {
    activeClosers: activeClosers.length,
    activeRelatedPrs: activeRelated.length,
    closedUnmergedAttempts: closedUnmerged.length,
    mergedClosers: mergedClosers.length,
    assigned: findings.some((item) => item.type === 'assigned'),
    claimRequired: findings.some((item) => item.type === 'claim_required'),
    issueOpen: issue?.state ? issue.state !== 'closed' : undefined,
    substantivePriorAttempt: closedUnmerged.some((item) => item.substantive === true)
  };
}

function buildCoverage(subResults: SubResult[], shortCircuited: boolean, extraNotChecked: string[]): RoutingCoverage {
  const failed = subResults.filter((result) => !result.ok);
  const failedChecks = failed.map((result) => result.name);
  const skipped = extraNotChecked
    .map((note) => note.match(/^(issue_vs_main|branch_scan|dupe_cluster|release_gap)/)?.[1])
    .filter((name): name is string => Boolean(name));
  const rateLimited = failed.some((result) => result.ok === false && /rate/i.test(result.error.code + result.error.message));
  const budgetTruncated = failed.some((result) => result.ok === false && /budget|truncat/i.test(result.error.code + result.error.message));
  const mandatoryFailed = failedChecks.includes('linked_work')
    || failedChecks.includes('contrib_policy')
    || (!shortCircuited && failedChecks.includes('issue_vs_main'));
  return {
    mandatory_checks_complete: !mandatoryFailed,
    failed_checks: failedChecks,
    skipped_checks: skipped,
    budget_truncated: budgetTruncated,
    rate_limit_degraded: rateLimited,
    snapshot_age_ms: 0,
    advisory_missing: shortCircuited ? skipped : []
  };
}

function categoryHintsFromIssue(issue?: IssueSnapshot): RouteFacts['categoryHints'] {
  if (!issue) return undefined;
  const labels = issue.labels.map((label) => label.toLowerCase());
  const documentation = labels.some((label) => label === 'documentation' || label === 'docs' || label === 'doc');
  const evaluation = labels.some((label) => label === 'eval' || label === 'benchmark' || label === 'evaluation');
  const implementation = labels.some((label) => label === 'bug' || label === 'enhancement' || label === 'feature');
  if ((!documentation && !evaluation) || implementation) return undefined;
  return { documentation: documentation && !implementation, evaluation: evaluation && !implementation };
}

function buildSourceSnapshot(input: {
  repo: string;
  issueNumber: number;
  issue?: IssueSnapshot;
  subResults: SubResult[];
  findings: Finding[];
}): SourceSnapshot {
  const linked_prs = linkedPrEvidence(input.subResults).flatMap((item) => {
    const number = typeof item.number === 'number' ? item.number : undefined;
    if (!number) return [];
    return [{
      number,
      state: typeof item.state === 'string' ? item.state : 'unknown',
      ...(typeof item.draft === 'boolean' ? { draft: item.draft } : {}),
      ...(typeof item.merged === 'boolean' ? { merged: item.merged } : {}),
      ...(typeof item.updated_at === 'string' ? { updated_at: item.updated_at } : {}),
      ...(typeof item.head_sha === 'string' ? { head_sha: item.head_sha } : {}),
      ...(typeof item.closes_issue === 'boolean' ? { closes_issue: item.closes_issue } : {})
    }];
  });
  const assignees = input.issue?.assignees ?? [];
  const fingerprint = stateFingerprint({
    repo: input.repo,
    issue_number: input.issueNumber,
    issue_state: input.issue?.state,
    issue_updated_at: input.issue?.updated_at,
    assignees,
    linked_prs,
    contribution_policy: {
      claim_required: input.findings.some((item) => item.type === 'claim_required'),
      no_pr_path: input.findings.some((item) => item.type === 'no_pr_path')
    }
  });
  return {
    observed_at: new Date().toISOString(),
    issue: input.issue
      ? {
        ...(input.issue.state ? { state: input.issue.state } : {}),
        ...(input.issue.updated_at ? { updated_at: input.issue.updated_at } : {}),
        assignees
      }
      : undefined,
    linked_prs,
    state_fingerprint: fingerprint
  };
}

function buildRouteFacts(
  decision: ReturnType<typeof decideFromSignals>,
  subResults: SubResult[],
  shortCircuited: boolean,
  extraNotChecked: string[],
  issue?: IssueSnapshot
): RouteFacts {
  const coverage = buildCoverage(subResults, shortCircuited, extraNotChecked);
  const quality = issue && typeof issue.title === 'string'
    ? assessIssueQuality({
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      assignees: issue.assignees,
      comments: issue.comments ?? 0,
      created_at: issue.created_at ?? new Date().toISOString(),
      updated_at: issue.updated_at ?? new Date().toISOString()
    })
    : undefined;
  return {
    verdict: decision.verdict,
    disposition: decision.disposition,
    findings: decision.findings,
    mandatoryFailures: coverage.failed_checks,
    linked: buildLinkedFacts(subResults, decision.findings, issue),
    quality: quality
      ? { looksLikeBug: quality.looks_like_bug, repro: quality.repro, softAsk: quality.soft_ask }
      : decision.findings.some((item) => item.type === 'needs_repro')
        ? { looksLikeBug: true, repro: 'missing', softAsk: false }
        : undefined,
    categoryHints: categoryHintsFromIssue(issue),
    coverage
  };
}

function finalize(
  sub_results: SubResult[],
  timings_ms: Record<string, number>,
  shortCircuited: boolean,
  extraNotChecked: string[] = [],
  context: { repo: string; issue_number: number; issue?: IssueSnapshot } = { repo: '', issue_number: 0 }
): WorthEnvelope {
  const errors = sub_results.filter((result) => !result.ok);
  const signals = [...new Set(sub_results.flatMap((result) => result.ok ? (result.result.signals ?? []) : []))] as Signal[];
  const density = linkedDensity(sub_results);
  const decision = decideFromSignals({
    signals,
    sub_results,
    errors,
    priorAttempts: density.priorAttempts,
    referencedCommits: density.referencedCommits,
    networkPrs: density.networkPrs
  });
  const reasons = [...decision.reasons];
  if (extraNotChecked.length > 0) {
    reasons.push(`perf short-circuit: skipped ${extraNotChecked.length} expensive sub-check${extraNotChecked.length === 1 ? '' : 's'} after open linked PR.`);
  }

  const base = createEnvelope({
    verdict_summary: decision.verdict === 'ACT' ? 'no blocking evidence found by completed checks.' : decision.verdict === 'SKIP' ? 'blocking evidence was found by completed checks.' : 'mixed signals or sub-check errors require human review.',
    evidence: decision.findings.map((item) => ({
      kind: 'finding',
      id: item.id,
      type: item.type,
      strength: item.strength,
      effect: item.effect,
      source: item.source,
      message: item.message,
      ...(item.url ? { url: item.url } : {}),
      data: item.data
    })),
    signals,
    checked: sub_results.filter((result) => result.ok).map((result) => result.name),
    not_checked: [...new Set([
      ...sub_results.flatMap((result) => result.ok ? result.result.not_checked : result.error.not_checked),
      ...extraNotChecked
    ])],
    cached: false
  });
  const routing = routeContribution(buildRouteFacts(decision, sub_results, shortCircuited, extraNotChecked, context.issue));
  const source_snapshot = context.repo
    ? buildSourceSnapshot({
      repo: context.repo,
      issueNumber: context.issue_number,
      issue: context.issue,
      subResults: sub_results,
      findings: decision.findings
    })
    : undefined;
  return {
    ...base,
    verdict: decision.verdict,
    disposition: decision.disposition,
    reasons,
    sub_results,
    timings_ms,
    perf: extractPerf(sub_results, shortCircuited),
    routing,
    ...(source_snapshot ? { source_snapshot } : {})
  };
}

async function recordLedgerBestEffort(input: Input, result: WorthEnvelope): Promise<void> {
  try {
    await upsertLedgerEntry({
      repo: input.repo,
      issue_number: input.issue_number,
      verdict: result.verdict,
      disposition: result.disposition,
      source: 'worth_check'
    });
  } catch {
    // ledger persistence is best-effort local memory; it must never fail a worth_check run.
  }
}

async function timed(name: string, timings: Record<string, number>, run: () => Promise<SubResult>): Promise<SubResult> {
  const started = Date.now();
  const result = await run();
  timings[name] = Date.now() - started;
  return result;
}

export async function worth_check(input: Input): Promise<WorthEnvelope> {
  const timings_ms: Record<string, number> = {};
  const totalStarted = Date.now();

  // Cheap title fetch for branch keywords; overlaps with linked_work's issue fetch but avoids waiting on clone.
  let issueKeywords = [String(input.issue_number)];
  let issueSnap: IssueSnapshot | undefined;
  const keywordsStarted = Date.now();
  try {
    const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
    issueKeywords = distinctiveTerms(issue.title, 8);
    issueSnap = {
      state: issue.state,
      updated_at: issue.updated_at,
      assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((label) => label.name),
      comments: issue.comments,
      created_at: issue.created_at
    };
  } catch {
    // Fall back to issue-number-only keywords; branch_scan still matches fix-<n> branches.
  }
  timings_ms.issue_keywords = Date.now() - keywordsStarted;
  const context = { repo: input.repo, issue_number: input.issue_number, issue: issueSnap };

  // Phase 1: cheap blockers in parallel (no clone).
  const phase1Started = Date.now();
  const phase1 = await Promise.all([
    timed('linked_work', timings_ms, () => runNamed('linked_work', () => linked_work({ repo: input.repo, issue_number: input.issue_number }))),
    timed('contrib_policy', timings_ms, () => runNamed('contrib_policy', () => contrib_policy({ repo: input.repo })))
  ]);
  timings_ms.phase1 = Date.now() - phase1Started;
  if (hasDefinitiveClosingOpenPr(phase1)) {
    const skipped = [
      'issue_vs_main skipped after definitive open closing PR (perf short-circuit).',
      'branch_scan skipped after definitive open closing PR (perf short-circuit).',
      'dupe_cluster skipped after definitive open closing PR (perf short-circuit).',
      ...(input.npm_package ? ['release_gap skipped after definitive open closing PR (perf short-circuit).'] : [])
    ];
    timings_ms.total = Date.now() - totalStarted;
    const shortCircuitResult = finalize(phase1, timings_ms, true, skipped, context);
    await recordLedgerBestEffort(input, shortCircuitResult);
    return shortCircuitResult;
  }

  // Phase 2: expensive checks in parallel (shared clone pool helps issue_vs_main + release_gap).
  const phase2Started = Date.now();
  const phase2 = await Promise.all([
    timed('issue_vs_main', timings_ms, () => runNamed('issue_vs_main', () => issue_vs_main(input))),
    timed('branch_scan', timings_ms, () => runNamed('branch_scan', () => branch_scan({ repo: input.repo, keywords: issueKeywords, issue_number: input.issue_number }))),
    timed('dupe_cluster', timings_ms, () => runNamed('dupe_cluster', () => dupe_cluster({ repo: input.repo, issue_number: input.issue_number }))),
    ...(input.npm_package
      ? [timed('release_gap', timings_ms, () => runNamed('release_gap', () => release_gap({ repo: input.repo, npm_package: input.npm_package!, probe: input.probe, probe_template: input.probe_template })))]
      : [])
  ]);
  timings_ms.phase2 = Date.now() - phase2Started;
  timings_ms.total = Date.now() - totalStarted;

  const result = finalize([...phase1, ...phase2], timings_ms, false, [], context);
  await recordLedgerBestEffort(input, result);
  return result;
}
