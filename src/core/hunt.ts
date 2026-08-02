import { randomUUID } from 'node:crypto';
import type { TargetManifest } from '../contracts/config.js';
import { toCheckResult } from '../contracts/serialize.js';
import { getLedgerEntry } from '../lib/ledger.js';
import { getRunRecord, persistCheckResultBestEffort, putRunRecord } from '../lib/store.js';
import { contrib_policy } from './contrib-policy.js';
import { createEnvelope, Envelope, Evidence, GitworthyError } from './envelope.js';
import { org_scan } from './org-scan.js';
import { RANKING_VERSION } from './rank.js';
import { resolvePackageForRepo } from './repo-select.js';
import { scan } from './scan.js';
import { SkillProfile } from './skill-fit.js';
import { worth_check } from './worth-check.js';

type Input = {
  repo?: string;
  org?: string;
  label?: string;
  keywords?: string[];
  since?: string;
  scan_limit?: number;
  max_repos?: number;
  max_checks?: number;
  max_pages?: number;
  land_hints?: boolean;
  skip_likely_land_only?: boolean;
  skip_soft_ask?: boolean;
  skip_assigned?: boolean;
  skip_ledger_skip?: boolean;
  skip_policy_gate?: boolean;
  npm_package?: string;
  skill_profile?: SkillProfile | string;
  explain_ranking?: boolean;
  target_manifest?: TargetManifest;
  capture_persist_checks?: boolean;
  /** Resume an incomplete hunt run (GW-028). */
  resume_run_id?: string;
};

type PolicyGate = { blocked: boolean; claimRequired: boolean; feedbackChannel?: string };

type HuntCandidate = {
  number: number;
  repo?: string;
  quality_score: number;
  fit_score?: number;
  rank_score?: number;
  ranking_version?: string;
  availability_hint_score?: number;
  likely_land_only: boolean;
  land_hint?: string;
  soft_ask: boolean;
  assignees: string[];
};

type HuntQueueItem = {
  repo: string;
  issue_number: number;
  quality_score: number;
  fit_score?: number;
  rank_score?: number;
};

type HuntRunMetrics = {
  hunt_version: 1;
  status: 'running' | 'complete' | 'partial';
  ranking_version: string;
  config: Record<string, unknown>;
  queue: HuntQueueItem[];
  completed_keys: string[];
  skipped_keys: Array<{ key: string; reason: string }>;
  max_checks: number;
  checks_run: number;
  partial_reason?: string;
};

const DEFAULT_SCAN_LIMIT = 25;
const DEFAULT_MAX_CHECKS = 3;
const MAX_MAX_CHECKS = 5;
const HUNT_LIMIT = 'hunt is a triage orchestrator, not a verdict: it chains scan/org_scan candidate discovery into serial worth_check calls and returns no signals of its own. Inspect each evidence.hunt_candidate.worth_check.verdict and .disposition individually before acting.';
const META_KINDS = new Set(['widen_hint', 'discovery', 'ranking_explain', 'repo_selection']);

function candidateKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function toHuntCandidate(item: Evidence): HuntCandidate | null {
  if (typeof item.number !== 'number') return null;
  if (typeof item.kind === 'string' && META_KINDS.has(item.kind)) return null;
  return {
    number: item.number,
    repo: typeof item.repo === 'string' ? item.repo : undefined,
    quality_score: typeof item.quality_score === 'number' ? item.quality_score : 0,
    fit_score: typeof item.fit_score === 'number' ? item.fit_score : undefined,
    rank_score: typeof item.rank_score === 'number' ? item.rank_score : undefined,
    ranking_version: typeof item.ranking_version === 'string' ? item.ranking_version : undefined,
    availability_hint_score: typeof item.availability_hint_score === 'number' ? item.availability_hint_score : undefined,
    likely_land_only: item.likely_land_only === true,
    land_hint: typeof item.land_hint === 'string' ? item.land_hint : undefined,
    soft_ask: item.soft_ask === true,
    assignees: Array.isArray(item.assignees) ? item.assignees.filter((entry): entry is string => typeof entry === 'string') : []
  };
}

async function filterCandidates(
  candidates: HuntCandidate[],
  input: Input
): Promise<{ eligible: HuntCandidate[]; filteredCount: number; reasonCounts: Map<string, number> }> {
  const skipLikelyLandOnly = input.skip_likely_land_only !== false;
  const skipSoftAsk = input.skip_soft_ask !== false;
  const skipAssigned = input.skip_assigned !== false;
  const skipLedgerSkip = input.skip_ledger_skip !== false;

  const eligible: HuntCandidate[] = [];
  const reasonCounts = new Map<string, number>();
  const note = (reason: string) => reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);

  for (const candidate of candidates) {
    if (skipLikelyLandOnly && candidate.likely_land_only) { note('likely_land_only'); continue; }
    if (skipSoftAsk && candidate.soft_ask) { note('soft_ask'); continue; }
    if (skipAssigned && candidate.assignees.length > 0) { note('assigned'); continue; }
    if (skipLedgerSkip) {
      const repo = candidate.repo ?? input.repo;
      if (repo) {
        const entry = await getLedgerEntry(repo, candidate.number);
        if (entry?.verdict === 'SKIP') { note('ledger_skip'); continue; }
      }
    }
    eligible.push(candidate);
  }

  const filteredCount = candidates.length - eligible.length;
  return { eligible, filteredCount, reasonCounts };
}

async function evaluatePolicyGate(
  repos: string[],
  evidence: Evidence[],
  checked: string[],
  notCheckedSet: Set<string>
): Promise<Map<string, PolicyGate>> {
  const gate = new Map<string, PolicyGate>();
  for (const repo of repos) {
    const policy = await contrib_policy({ repo });
    policy.not_checked.forEach((item) => notCheckedSet.add(item));
    const blocked = policy.signals.includes('no_pr_path');
    const claimRequired = policy.signals.includes('claim_required');
    const feedbackChannel = blocked
      ? (policy.evidence.find((item) => item.category === 'no_pr_path' && typeof item.feedback_channel === 'string')?.feedback_channel as string | undefined)
      : undefined;
    gate.set(repo, { blocked, claimRequired, feedbackChannel });
    if (blocked) {
      evidence.push({
        kind: 'policy_gate',
        repo,
        action: 'blocked',
        signal: 'no_pr_path',
        ...(feedbackChannel ? { feedback_channel: feedbackChannel } : {})
      });
      checked.push(`policy_gate: ${repo} rejects pull requests (no_pr_path); skipping worth_check for its candidate(s)`);
    } else if (claimRequired) {
      evidence.push({ kind: 'policy_gate', repo, action: 'claim_first', signal: 'claim_required' });
      checked.push(`policy_gate warning: ${repo} requires claim/assignment before a PR (claim_required); worth_check will still run`);
    } else {
      checked.push(`policy_gate: ${repo} has no blocking contribution-policy signal`);
    }
  }
  return gate;
}

function configFingerprint(input: Input): Record<string, unknown> {
  return {
    repo: input.repo ?? null,
    org: input.org ?? null,
    label: input.label ?? null,
    keywords: input.keywords ?? null,
    since: input.since ?? null,
    scan_limit: input.scan_limit ?? null,
    max_repos: input.max_repos ?? null,
    max_checks: input.max_checks ?? null,
    max_pages: input.max_pages ?? null,
    land_hints: input.land_hints ?? null,
    skip_likely_land_only: input.skip_likely_land_only ?? null,
    skip_soft_ask: input.skip_soft_ask ?? null,
    skip_assigned: input.skip_assigned ?? null,
    skip_ledger_skip: input.skip_ledger_skip ?? null,
    skip_policy_gate: input.skip_policy_gate ?? null,
    skill_profile: input.skill_profile ?? null,
    npm_package: input.npm_package ?? null,
    target_manifest: input.target_manifest ?? null,
    ranking_version: RANKING_VERSION
  };
}

function readHuntMetrics(metrics: Record<string, unknown> | undefined): HuntRunMetrics | null {
  if (!metrics || metrics.hunt_version !== 1) return null;
  if (!Array.isArray(metrics.queue) || !Array.isArray(metrics.completed_keys)) return null;
  return metrics as unknown as HuntRunMetrics;
}

async function persistHuntRun(runId: string, metrics: HuntRunMetrics, checked: string[], notChecked: string[]): Promise<void> {
  try {
    await putRunRecord({
      run_id: runId,
      command: 'hunt',
      generated_at: new Date().toISOString(),
      cached: false,
      summary: `hunt ${metrics.status}: ${metrics.checks_run}/${metrics.max_checks} checks, ${metrics.completed_keys.length} completed, ${metrics.queue.length} queued`,
      checked,
      not_checked: notChecked,
      metrics: metrics as unknown as Record<string, unknown>
    });
  } catch {
    // best-effort
  }
}

function compactCandidateEvidence(input: {
  repo: string;
  issue_number: number;
  quality_score: number;
  fit_score?: number;
  rank_score?: number;
  land_hint?: string;
  result: Awaited<ReturnType<typeof worth_check>>;
  capturedCheck?: ReturnType<typeof toCheckResult>;
  status: 'complete' | 'failed';
  failure_reason?: string;
}): Evidence {
  const findings = (input.result.evidence ?? []).filter((item) => item.kind === 'finding');
  const urls = findings
    .map((item) => (typeof item.url === 'string' ? item.url : undefined))
    .filter((url): url is string => Boolean(url));
  const next_actions = input.capturedCheck?.next_actions ?? [];
  return {
    kind: 'hunt_candidate',
    repo: input.repo,
    issue_number: input.issue_number,
    quality_score: input.quality_score,
    ...(input.fit_score !== undefined ? { fit_score: input.fit_score } : {}),
    ...(input.rank_score !== undefined ? { rank_score: input.rank_score } : {}),
    ranking_version: RANKING_VERSION,
    ...(input.land_hint ? { land_hint: input.land_hint } : {}),
    status: input.status,
    ...(input.failure_reason ? { failure_reason: input.failure_reason } : {}),
    worth_check: {
      verdict: input.result.verdict,
      disposition: input.result.disposition,
      summary: input.result.verdict_summary,
      reasons: input.result.reasons,
      findings: findings.map((item) => ({
        type: item.type,
        strength: item.strength,
        effect: item.effect,
        message: item.message,
        ...(typeof item.url === 'string' ? { url: item.url } : {})
      })),
      evidence_urls: urls,
      next_actions,
      checked: input.result.checked,
      not_checked: input.result.not_checked,
      limitations: input.result.not_checked.slice(0, 8),
      ...(input.capturedCheck
        ? { run_id: input.capturedCheck.run_id, decision_id: input.capturedCheck.decision_id }
        : {})
    }
  };
}

async function discoverCandidates(input: Input): Promise<{ scanResult: Envelope; scanCandidates: HuntCandidate[] }> {
  const scanLimit = Number.isFinite(input.scan_limit) ? Math.max(1, input.scan_limit as number) : DEFAULT_SCAN_LIMIT;
  const useOrgMode = Boolean(input.org);
  const scanResult = useOrgMode
    ? await org_scan({
      org: input.org!,
      label: input.label,
      keywords: input.keywords,
      since: input.since,
      limit: scanLimit,
      max_repos: input.max_repos,
      land_hints: input.land_hints,
      skill_profile: input.skill_profile,
      max_pages: input.max_pages,
      explain_ranking: input.explain_ranking,
      target_manifest: input.target_manifest
    })
    : await scan({
      repo: input.repo!,
      label: input.label,
      keywords: input.keywords,
      since: input.since,
      limit: scanLimit,
      land_hints: input.land_hints,
      skill_profile: input.skill_profile,
      max_pages: input.max_pages,
      explain_ranking: input.explain_ranking
    });
  const scanCandidates = scanResult.evidence.map(toHuntCandidate).filter((item): item is HuntCandidate => item !== null);
  return { scanResult, scanCandidates };
}

export async function hunt(input: Input): Promise<Envelope> {
  if (input.resume_run_id) {
    return resumeHunt(input.resume_run_id, input);
  }

  if (!input.repo && !input.org) {
    throw new GitworthyError({
      code: 'hunt_invalid_input',
      message: 'hunt requires either repo or org.',
      not_checked: ['hunt requires either repo or org; neither was provided.']
    });
  }

  const requestedChecks = input.max_checks ?? DEFAULT_MAX_CHECKS;
  if (!Number.isFinite(requestedChecks)) {
    throw new GitworthyError({
      code: 'hunt_invalid_input',
      message: 'hunt max_checks must be a finite positive number.',
      not_checked: ['hunt max_checks was not a finite number.']
    });
  }
  const maxChecks = Math.min(Math.max(requestedChecks, 1), MAX_MAX_CHECKS);
  const useOrgMode = Boolean(input.org);
  const huntRunId = `run_hunt_${randomUUID().replace(/-/g, '')}`;

  const { scanResult, scanCandidates } = await discoverCandidates(input);
  const { eligible, filteredCount, reasonCounts } = await filterCandidates(scanCandidates, input);
  const ordered = [...eligible].sort((left, right) =>
    (right.rank_score ?? 0) - (left.rank_score ?? 0)
    || right.quality_score - left.quality_score
    || (right.fit_score ?? 0) - (left.fit_score ?? 0)
  );

  const evidence: Evidence[] = [];
  if (input.explain_ranking) {
    const rankingMeta = scanResult.evidence.find((item) => item.kind === 'ranking_explain');
    if (rankingMeta) evidence.push(rankingMeta);
    const discoveryMeta = scanResult.evidence.find((item) => item.kind === 'discovery');
    if (discoveryMeta) evidence.push(discoveryMeta);
    const selectionMeta = scanResult.evidence.find((item) => item.kind === 'repo_selection');
    if (selectionMeta) evidence.push(selectionMeta);
  }

  const dispositionCounts = new Map<string, number>();
  const checked: string[] = [
    useOrgMode ? `ran org_scan for ${input.org}` : `ran scan for ${input.repo}`,
    ...(useOrgMode && input.repo ? ['both repo and org were provided; org took precedence for candidate discovery.'] : []),
    `discovered ${scanCandidates.length} scan candidate${scanCandidates.length === 1 ? '' : 's'}`,
    `applied hunt filters (skip_likely_land_only=${input.skip_likely_land_only !== false}, skip_soft_ask=${input.skip_soft_ask !== false}, skip_assigned=${input.skip_assigned !== false}, skip_ledger_skip=${input.skip_ledger_skip !== false}): ${eligible.length} eligible, ${filteredCount} filtered`,
    `will run up to ${maxChecks} worth_check(s) from ${eligible.length} eligible candidate(s), backfilling past policy-blocked repos`,
    `hunt run_id=${huntRunId} (resume with: gitworthy run resume ${huntRunId})`,
    ...scanResult.checked
  ];
  const notCheckedSet = new Set<string>(scanResult.not_checked);

  const skipPolicyGate = input.skip_policy_gate === true;
  const policyGate = new Map<string, PolicyGate>();
  if (skipPolicyGate) {
    checked.push('policy gate skipped (skip_policy_gate=true); worth_check ran without a contrib_policy pre-check');
  }

  let policyBlockedCount = 0;
  let checksRun = 0;
  const deferred: HuntCandidate[] = [];
  const queue = [...ordered];
  const metrics: HuntRunMetrics = {
    hunt_version: 1,
    status: 'running',
    ranking_version: RANKING_VERSION,
    config: configFingerprint({ ...input, max_checks: maxChecks }),
    queue: ordered.map((item) => ({
      repo: item.repo ?? input.repo!,
      issue_number: item.number,
      quality_score: item.quality_score,
      ...(item.fit_score !== undefined ? { fit_score: item.fit_score } : {}),
      ...(item.rank_score !== undefined ? { rank_score: item.rank_score } : {})
    })),
    completed_keys: [],
    skipped_keys: [],
    max_checks: maxChecks,
    checks_run: 0
  };
  await persistHuntRun(huntRunId, metrics, checked, [...notCheckedSet]);

  while (queue.length > 0) {
    if (checksRun >= maxChecks) {
      deferred.push(...queue);
      break;
    }
    const candidate = queue.shift()!;
    const repo = candidate.repo ?? input.repo!;
    const key = candidateKey(repo, candidate.number);
    if (!skipPolicyGate) {
      if (!policyGate.has(repo)) {
        const evaluated = await evaluatePolicyGate([repo], evidence, checked, notCheckedSet);
        for (const [gateKey, value] of evaluated) policyGate.set(gateKey, value);
      }
      if (policyGate.get(repo)?.blocked) {
        policyBlockedCount += 1;
        metrics.skipped_keys.push({ key, reason: 'policy_blocked' });
        metrics.queue = metrics.queue.filter((item) => candidateKey(item.repo, item.issue_number) !== key);
        await persistHuntRun(huntRunId, metrics, checked, [...notCheckedSet]);
        continue;
      }
    }

    const pkg = resolvePackageForRepo(repo, input.target_manifest, input.npm_package);
    if (pkg.warning) notCheckedSet.add(pkg.warning);

    try {
      const result = await worth_check({ repo, issue_number: candidate.number, npm_package: pkg.npm_package });
      checksRun += 1;
      let capturedCheck: ReturnType<typeof toCheckResult> | undefined;
      try {
        capturedCheck = toCheckResult(result as unknown as Record<string, unknown>, { repo, issue_number: candidate.number });
        await persistCheckResultBestEffort(capturedCheck);
      } catch {
        // Compact evidence still returns without durable decision ids when mapping/persist fails.
      }
      dispositionCounts.set(result.disposition, (dispositionCounts.get(result.disposition) ?? 0) + 1);
      evidence.push(compactCandidateEvidence({
        repo,
        issue_number: candidate.number,
        quality_score: candidate.quality_score,
        fit_score: candidate.fit_score,
        rank_score: candidate.rank_score,
        land_hint: candidate.land_hint,
        result,
        capturedCheck,
        status: 'complete'
      }));
      checked.push(`worth_check ${repo}#${candidate.number} -> ${result.verdict}/${result.disposition} (checked: ${result.checked.join(', ') || 'none'})`);
      result.not_checked.forEach((item) => notCheckedSet.add(item));
      metrics.completed_keys.push(key);
      metrics.checks_run = checksRun;
      metrics.queue = metrics.queue.filter((item) => candidateKey(item.repo, item.issue_number) !== key);
      await persistHuntRun(huntRunId, metrics, checked, [...notCheckedSet]);
    } catch (error) {
      // Failed attempts still consume max_checks budget so flaky providers cannot fan out unbounded.
      checksRun += 1;
      const message = error instanceof Error ? error.message : String(error);
      metrics.status = 'partial';
      metrics.partial_reason = message;
      metrics.skipped_keys.push({ key, reason: `provider_error: ${message}` });
      metrics.checks_run = checksRun;
      metrics.queue = metrics.queue.filter((item) => candidateKey(item.repo, item.issue_number) !== key);
      evidence.push({
        kind: 'hunt_candidate',
        repo,
        issue_number: candidate.number,
        status: 'failed',
        failure_reason: message,
        quality_score: candidate.quality_score,
        ...(candidate.fit_score !== undefined ? { fit_score: candidate.fit_score } : {}),
        ranking_version: RANKING_VERSION
      });
      checked.push(`worth_check ${repo}#${candidate.number} failed: ${message}`);
      await persistHuntRun(huntRunId, metrics, checked, [...notCheckedSet]);
      // Continue remaining queue — one failure does not discard the hunt.
    }
  }

  if (policyBlockedCount > 0) {
    notCheckedSet.add(`${policyBlockedCount} candidate(s) were blocked by the contrib_policy gate (no_pr_path) and were not run through worth_check.`);
  }

  if (filteredCount > 0) {
    evidence.push({
      kind: 'hunt_filtered',
      count: filteredCount,
      reasons: [...reasonCounts.entries()].map(([reason, count]) => `${reason}: ${count}`)
    });
  }

  if (deferred.length > 0) {
    notCheckedSet.add(`${deferred.length} eligible candidate(s) exceeded max_checks=${maxChecks} and were not run through worth_check: ${deferred.map((item) => `#${item.number}`).join(', ')}`);
  }
  notCheckedSet.add(HUNT_LIMIT);

  metrics.status = metrics.status === 'partial' || deferred.length > 0 ? 'partial' : 'complete';
  if (deferred.length > 0 && !metrics.partial_reason) {
    metrics.partial_reason = `max_checks=${maxChecks} reached with ${deferred.length} remaining`;
  }
  await persistHuntRun(huntRunId, metrics, checked, [...notCheckedSet]);

  const dispositionSummary = dispositionCounts.size > 0
    ? [...dispositionCounts.entries()].map(([disposition, count]) => `${disposition} x${count}`).join(', ')
    : 'none (no candidates checked)';

  evidence.unshift({
    kind: 'hunt_run',
    run_id: huntRunId,
    status: metrics.status,
    ranking_version: RANKING_VERSION,
    checks_run: checksRun,
    remaining: metrics.queue.length,
    ...(metrics.partial_reason ? { partial_reason: metrics.partial_reason } : {})
  });

  return createEnvelope({
    verdict_summary: `hunted ${checksRun} check${checksRun === 1 ? '' : 's'} from ${scanCandidates.length} scan candidate${scanCandidates.length === 1 ? '' : 's'} (${filteredCount} filtered${policyBlockedCount > 0 ? `, ${policyBlockedCount} policy-blocked` : ''}); dispositions: ${dispositionSummary}; run_id=${huntRunId}`,
    evidence,
    checked,
    not_checked: [...notCheckedSet],
    cached: false
  });
}

/** Continue an incomplete hunt without re-running completed candidates. */
export async function resumeHunt(runId: string, overrides: Input = {}): Promise<Envelope> {
  const record = await getRunRecord(runId);
  if (!record || record.command !== 'hunt') {
    throw new GitworthyError({
      code: 'hunt_resume_missing',
      message: `No hunt run found for ${runId}.`,
      not_checked: [`hunt resume could not load run ${runId}.`]
    });
  }
  const metrics = readHuntMetrics(record.metrics);
  if (!metrics) {
    throw new GitworthyError({
      code: 'hunt_resume_incompatible',
      message: `Run ${runId} is not a resumable hunt record.`,
      not_checked: ['hunt resume requires hunt_version metrics on the run record.']
    });
  }
  if (metrics.ranking_version !== RANKING_VERSION) {
    throw new GitworthyError({
      code: 'hunt_resume_stale',
      message: `Run ${runId} used ranking_version=${metrics.ranking_version}; current is ${RANKING_VERSION}.`,
      not_checked: ['ranking_version changed; start a new hunt instead of resuming.']
    });
  }
  if (metrics.status === 'complete' && metrics.queue.length === 0) {
    return createEnvelope({
      verdict_summary: `hunt ${runId} already complete (${metrics.checks_run} checks).`,
      evidence: [{ kind: 'hunt_run', run_id: runId, status: 'complete', checks_run: metrics.checks_run, remaining: 0 }],
      checked: [`loaded completed hunt run ${runId}`],
      not_checked: [HUNT_LIMIT],
      cached: true
    });
  }

  const cfg = metrics.config;
  const savedManifest = cfg.target_manifest && typeof cfg.target_manifest === 'object'
    ? cfg.target_manifest as TargetManifest
    : undefined;
  const boolOr = (saved: unknown, override: boolean | undefined): boolean | undefined => {
    if (typeof override === 'boolean') return override;
    return typeof saved === 'boolean' ? saved : undefined;
  };
  const input: Input = {
    repo: typeof cfg.repo === 'string' ? cfg.repo : overrides.repo,
    org: typeof cfg.org === 'string' ? cfg.org : overrides.org,
    label: typeof cfg.label === 'string' ? cfg.label : overrides.label,
    keywords: Array.isArray(cfg.keywords) ? cfg.keywords as string[] : overrides.keywords,
    since: typeof cfg.since === 'string' ? cfg.since : overrides.since,
    scan_limit: typeof cfg.scan_limit === 'number' ? cfg.scan_limit : overrides.scan_limit,
    max_repos: typeof cfg.max_repos === 'number' ? cfg.max_repos : overrides.max_repos,
    max_checks: metrics.max_checks,
    max_pages: typeof cfg.max_pages === 'number' ? cfg.max_pages : overrides.max_pages,
    npm_package: typeof cfg.npm_package === 'string' ? cfg.npm_package : overrides.npm_package,
    skill_profile: (cfg.skill_profile as Input['skill_profile']) ?? overrides.skill_profile,
    target_manifest: overrides.target_manifest ?? savedManifest,
    skip_policy_gate: boolOr(cfg.skip_policy_gate, overrides.skip_policy_gate),
    skip_likely_land_only: boolOr(cfg.skip_likely_land_only, overrides.skip_likely_land_only),
    skip_soft_ask: boolOr(cfg.skip_soft_ask, overrides.skip_soft_ask),
    skip_assigned: boolOr(cfg.skip_assigned, overrides.skip_assigned),
    skip_ledger_skip: boolOr(cfg.skip_ledger_skip, overrides.skip_ledger_skip),
    land_hints: boolOr(cfg.land_hints, overrides.land_hints)
  };

  const remainingBudget = Math.max(0, metrics.max_checks - metrics.checks_run);
  const evidence: Evidence[] = [{
    kind: 'hunt_run',
    run_id: runId,
    status: 'running',
    ranking_version: RANKING_VERSION,
    checks_run: metrics.checks_run,
    remaining: metrics.queue.length,
    resumed: true
  }];
  const checked: string[] = [
    `resumed hunt run ${runId}`,
    `remaining budget ${remainingBudget} check(s); ${metrics.queue.length} queued; ${metrics.completed_keys.length} already complete`
  ];
  const notCheckedSet = new Set<string>([HUNT_LIMIT]);
  const dispositionCounts = new Map<string, number>();
  const skipPolicyGate = input.skip_policy_gate === true;
  const policyGate = new Map<string, PolicyGate>();
  let checksRun = 0;
  let policyBlockedCount = 0;

  const queue = [...metrics.queue];
  metrics.status = 'running';

  while (queue.length > 0 && checksRun < remainingBudget) {
    const item = queue.shift()!;
    const key = candidateKey(item.repo, item.issue_number);
    if (metrics.completed_keys.includes(key)) continue;

    if (!skipPolicyGate) {
      if (!policyGate.has(item.repo)) {
        const evaluated = await evaluatePolicyGate([item.repo], evidence, checked, notCheckedSet);
        for (const [gateKey, value] of evaluated) policyGate.set(gateKey, value);
      }
      if (policyGate.get(item.repo)?.blocked) {
        policyBlockedCount += 1;
        metrics.skipped_keys.push({ key, reason: 'policy_blocked' });
        metrics.queue = queue;
        await persistHuntRun(runId, metrics, checked, [...notCheckedSet]);
        continue;
      }
    }

    const pkg = resolvePackageForRepo(item.repo, input.target_manifest, input.npm_package);
    if (pkg.warning) notCheckedSet.add(pkg.warning);

    try {
      const result = await worth_check({ repo: item.repo, issue_number: item.issue_number, npm_package: pkg.npm_package });
      checksRun += 1;
      metrics.checks_run += 1;
      let capturedCheck: ReturnType<typeof toCheckResult> | undefined;
      try {
        capturedCheck = toCheckResult(result as unknown as Record<string, unknown>, { repo: item.repo, issue_number: item.issue_number });
        await persistCheckResultBestEffort(capturedCheck);
      } catch {
        // best-effort mapping/persist
      }
      metrics.completed_keys.push(key);
      metrics.queue = queue;
      dispositionCounts.set(result.disposition, (dispositionCounts.get(result.disposition) ?? 0) + 1);
      evidence.push(compactCandidateEvidence({
        repo: item.repo,
        issue_number: item.issue_number,
        quality_score: item.quality_score,
        fit_score: item.fit_score,
        rank_score: item.rank_score,
        result,
        capturedCheck,
        status: 'complete'
      }));
      checked.push(`worth_check ${item.repo}#${item.issue_number} -> ${result.verdict}/${result.disposition}`);
      await persistHuntRun(runId, metrics, checked, [...notCheckedSet]);
    } catch (error) {
      checksRun += 1;
      metrics.checks_run += 1;
      const message = error instanceof Error ? error.message : String(error);
      metrics.status = 'partial';
      metrics.partial_reason = message;
      metrics.skipped_keys.push({ key, reason: `provider_error: ${message}` });
      metrics.queue = queue;
      evidence.push({
        kind: 'hunt_candidate',
        repo: item.repo,
        issue_number: item.issue_number,
        status: 'failed',
        failure_reason: message,
        quality_score: item.quality_score,
        ranking_version: RANKING_VERSION
      });
      await persistHuntRun(runId, metrics, checked, [...notCheckedSet]);
    }
  }

  metrics.queue = queue;
  metrics.status = queue.length === 0 && metrics.status !== 'partial' ? 'complete' : 'partial';
  if (queue.length > 0 && !metrics.partial_reason) {
    metrics.partial_reason = `resume budget exhausted with ${queue.length} remaining`;
  }
  await persistHuntRun(runId, metrics, checked, [...notCheckedSet]);

  if (policyBlockedCount > 0) {
    notCheckedSet.add(`${policyBlockedCount} candidate(s) were blocked by the contrib_policy gate during resume.`);
  }

  const dispositionSummary = dispositionCounts.size > 0
    ? [...dispositionCounts.entries()].map(([disposition, count]) => `${disposition} x${count}`).join(', ')
    : 'none';

  return createEnvelope({
    verdict_summary: `resumed hunt ${runId}: ran ${checksRun} additional check${checksRun === 1 ? '' : 's'}; status=${metrics.status}; dispositions: ${dispositionSummary}`,
    evidence,
    checked,
    not_checked: [...notCheckedSet],
    cached: false
  });
}
