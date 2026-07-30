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

type Input = { repo: string; issue_number: number; npm_package?: string; probe?: { file_glob?: string; contains?: string } };
type SubResult = { name: string; ok: true; result: Envelope } | { name: string; ok: false; error: { code: string; message: string; not_checked: string[] } };

export type Disposition = 'greenfield' | 'land_only' | 'claim_first' | 'blocked' | 'crowded' | 'review';

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
};

const CROWDED_PRIOR_ATTEMPTS = 2;
const CROWDED_COMMITS = 3;

function noPrFeedbackChannel(subResults: SubResult[]): string {
  const policy = subResults.find((result) => result.ok && result.name === 'contrib_policy');
  if (!policy?.ok) return 'not stated';
  const evidence = policy.result.evidence.find((item) => item.category === 'no_pr_path' && typeof item.feedback_channel === 'string');
  return typeof evidence?.feedback_channel === 'string' ? evidence.feedback_channel : 'not stated';
}

function claimProtocolCitation(subResults: SubResult[]): string {
  const policy = subResults.find((result) => result.ok && result.name === 'contrib_policy');
  if (!policy?.ok) return 'follow repo claim/assignment instructions before opening a PR';
  const evidence = policy.result.evidence.find((item) => item.category === 'claim_required' && typeof item.excerpt === 'string');
  return typeof evidence?.excerpt === 'string' ? evidence.excerpt : 'follow repo claim/assignment instructions before opening a PR';
}

function linkedPrCitation(subResults: SubResult[], predicate: (item: Record<string, unknown>) => boolean): string | null {
  const linked = subResults.find((result) => result.ok && result.name === 'linked_work');
  if (!linked?.ok) return null;
  const evidence = linked.result.evidence.find((item) => item.kind === 'linked_pr' && item.ignored_reason !== 'automation_author' && typeof item.number === 'number' && predicate(item));
  return evidence ? `#${evidence.number}${typeof evidence.url === 'string' ? ` ${evidence.url}` : ''}` : null;
}

function assignmentCitation(subResults: SubResult[]): string | null {
  const linked = subResults.find((result) => result.ok && result.name === 'linked_work');
  if (!linked?.ok) return null;
  const evidence = linked.result.evidence.find((item) => item.kind === 'assignment' && typeof item.assignee === 'string');
  if (!evidence || typeof evidence.assignee !== 'string') return null;
  return `${evidence.assignee}${typeof evidence.assigned_at === 'string' ? ` at ${evidence.assigned_at}` : ''}`;
}

function linkedDensity(subResults: SubResult[]): { priorAttempts: number; referencedCommits: number; openCloser: string | null } {
  const linked = subResults.find((result) => result.ok && result.name === 'linked_work');
  if (!linked?.ok) return { priorAttempts: 0, referencedCommits: 0, openCloser: null };
  const prs = linked.result.evidence.filter((item) => item.kind === 'linked_pr' && item.ignored_reason !== 'automation_author');
  const priorAttempts = prs.filter((item) => item.prior_attempt === true || (item.state === 'closed' && item.merged !== true)).length;
  const referencedCommits = linked.result.evidence.filter((item) => item.kind === 'referenced_commit').length;
  const openWithCloses = prs.find((item) => item.state === 'open' && item.closes_issue === true);
  const openAny = prs.find((item) => item.state === 'open');
  const chosen = openWithCloses ?? openAny;
  const openCloser = chosen && typeof chosen.number === 'number'
    ? `#${chosen.number}${typeof chosen.url === 'string' ? ` ${chosen.url}` : ''}`
    : null;
  return { priorAttempts, referencedCommits, openCloser };
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

function hasCleanLinkedWork(subResults: SubResult[]): boolean {
  const linked = subResults.find((result) => result.name === 'linked_work');
  return Boolean(linked?.ok && (linked.result.signals ?? []).length === 0);
}

function isBranchOnlySkipSignal(signals: Signal[], subResults: SubResult[]): boolean {
  if (!hasCleanLinkedWork(subResults)) return false;
  const blocking = signals.filter((signal) => !['no_pr_path', 'linked_pr_merged', 'linked_pr_closed', 'assigned', 'needs_repro', 'claim_required'].includes(signal));
  return blocking.length === 1 && blocking[0] === 'in_flight';
}

function hasOpenLinkedPr(subResults: SubResult[]): boolean {
  const linked = subResults.find((result) => result.ok && result.name === 'linked_work');
  return Boolean(linked?.ok && linked.result.signals.includes('linked_pr_open'));
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
}): Disposition {
  const { verdict, signals, priorAttempts, referencedCommits } = input;
  if (signals.some((signal) => ['shipped', 'released_fix', 'duplicate'].includes(signal))) return 'blocked';
  if (signals.includes('linked_pr_open')) return 'land_only';
  if (signals.includes('assigned') || signals.includes('claim_required')) return 'claim_first';
  if (priorAttempts >= CROWDED_PRIOR_ATTEMPTS || referencedCommits >= CROWDED_COMMITS) return 'crowded';
  if (verdict === 'ACT') return 'greenfield';
  return 'review';
}

function finalize(
  sub_results: SubResult[],
  timings_ms: Record<string, number>,
  shortCircuited: boolean,
  extraNotChecked: string[] = []
): WorthEnvelope {
  const reasons: string[] = [];
  const errors = sub_results.filter((result) => !result.ok);
  const signals = [...new Set(sub_results.flatMap((result) => result.ok ? (result.result.signals ?? []) : []))] as Signal[];
  const verifySignals: Signal[] = ['no_pr_path', 'linked_pr_merged', 'linked_pr_closed', 'assigned', 'needs_repro', 'claim_required'];
  const skipSignals = signals.filter((signal) => !verifySignals.includes(signal));
  const branchOnlyInFlightWithCleanLinkedWork = isBranchOnlySkipSignal(signals, sub_results);
  const density = linkedDensity(sub_results);
  for (const result of sub_results) {
    if (!result.ok) reasons.push(`${result.name} errored: ${result.error.message}`);
    if (result.ok && (result.result.signals ?? []).length > 0) reasons.push(`${result.name}: ${(result.result.signals ?? []).join(', ')}`);
  }
  let verdict: 'ACT' | 'VERIFY' | 'SKIP' = 'ACT';
  if (errors.length > 0) verdict = 'VERIFY';
  else if (branchOnlyInFlightWithCleanLinkedWork) verdict = 'VERIFY';
  else if (skipSignals.length > 0) verdict = 'SKIP';
  else if (signals.some((signal) => verifySignals.includes(signal))) verdict = 'VERIFY';
  if (branchOnlyInFlightWithCleanLinkedWork) reasons.push('keyword-matched branches exist but no linked PR or assignee; read the matched branches.');
  if (signals.includes('no_pr_path')) reasons.push(`repo accepts no pull requests; feedback channel: ${noPrFeedbackChannel(sub_results)}`);
  if (signals.includes('claim_required')) reasons.push(`repo requires claim/assignment before a PR: ${claimProtocolCitation(sub_results)}`);
  if (signals.includes('needs_repro')) reasons.push('bug-shaped issue lacks reproduction steps; confirm the failure before investing.');
  if (signals.includes('linked_pr_open')) {
    const citation = density.openCloser
      ?? linkedPrCitation(sub_results, (item) => item.state === 'open')
      ?? 'citation unavailable';
    reasons.push(`open linked PR found: ${citation}`);
    reasons.push(`disposition land_only: do not open a parallel fix; review or land ${citation}.`);
  }
  if (signals.includes('assigned')) reasons.push(`issue is assigned: ${assignmentCitation(sub_results) ?? 'assignee date unavailable'}`);
  if (signals.includes('linked_pr_merged')) reasons.push(`linked PR was merged: ${linkedPrCitation(sub_results, (item) => item.merged === true) ?? 'citation unavailable'}`);
  if (signals.includes('linked_pr_closed')) reasons.push(`closed unmerged linked PR found (prior attempt): ${linkedPrCitation(sub_results, (item) => item.state === 'closed' && item.merged !== true) ?? 'citation unavailable'}`);
  if (density.priorAttempts > 0 || density.referencedCommits > 0) {
    reasons.push(`lane density: ${density.priorAttempts} prior closed unmerged PR(s), ${density.referencedCommits} referenced commit(s).`);
  }

  const disposition = chooseDisposition({
    verdict,
    signals,
    priorAttempts: density.priorAttempts,
    referencedCommits: density.referencedCommits
  });
  if (disposition === 'crowded' && !signals.includes('linked_pr_open')) {
    reasons.push('disposition crowded: multiple prior attempts or referenced commits — read linked_work evidence before investing.');
  }
  if (disposition === 'claim_first') {
    reasons.push('disposition claim_first: coordinate or claim before opening a PR.');
  }
  if (disposition === 'blocked') {
    reasons.push('disposition blocked: work appears already handled (shipped, released, or duplicate).');
  }
  if (extraNotChecked.length > 0) {
    reasons.push(`perf short-circuit: skipped ${extraNotChecked.length} expensive sub-check${extraNotChecked.length === 1 ? '' : 's'} after open linked PR.`);
  }

  const base = createEnvelope({
    verdict_summary: verdict === 'ACT' ? 'no blocking evidence found by completed checks.' : verdict === 'SKIP' ? 'blocking evidence was found by completed checks.' : 'mixed signals or sub-check errors require human review.',
    evidence: [],
    signals,
    checked: sub_results.filter((result) => result.ok).map((result) => result.name),
    not_checked: [...new Set([
      ...sub_results.flatMap((result) => result.ok ? result.result.not_checked : result.error.not_checked),
      ...extraNotChecked
    ])],
    cached: false
  });
  return {
    ...base,
    verdict,
    disposition,
    reasons,
    sub_results,
    timings_ms,
    perf: extractPerf(sub_results, shortCircuited)
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
  const keywordsStarted = Date.now();
  try {
    const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
    issueKeywords = distinctiveTerms(issue.title, 8);
  } catch {
    // Fall back to issue-number-only keywords; branch_scan still matches fix-<n> branches.
  }
  timings_ms.issue_keywords = Date.now() - keywordsStarted;

  // Phase 1: cheap blockers in parallel (no clone).
  const phase1Started = Date.now();
  const phase1 = await Promise.all([
    timed('linked_work', timings_ms, () => runNamed('linked_work', () => linked_work({ repo: input.repo, issue_number: input.issue_number }))),
    timed('contrib_policy', timings_ms, () => runNamed('contrib_policy', () => contrib_policy({ repo: input.repo })))
  ]);
  timings_ms.phase1 = Date.now() - phase1Started;
  if (hasOpenLinkedPr(phase1)) {
    const skipped = [
      'issue_vs_main skipped after open linked PR (perf short-circuit).',
      'branch_scan skipped after open linked PR (perf short-circuit).',
      'dupe_cluster skipped after open linked PR (perf short-circuit).',
      ...(input.npm_package ? ['release_gap skipped after open linked PR (perf short-circuit).'] : [])
    ];
    timings_ms.total = Date.now() - totalStarted;
    const shortCircuitResult = finalize(phase1, timings_ms, true, skipped);
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
      ? [timed('release_gap', timings_ms, () => runNamed('release_gap', () => release_gap({ repo: input.repo, npm_package: input.npm_package!, probe: input.probe })))]
      : [])
  ]);
  timings_ms.phase2 = Date.now() - phase2Started;
  timings_ms.total = Date.now() - totalStarted;

  const result = finalize([...phase1, ...phase2], timings_ms, false);
  await recordLedgerBestEffort(input, result);
  return result;
}
