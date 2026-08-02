import { getLedgerEntry } from '../lib/ledger.js';
import { contrib_policy } from './contrib-policy.js';
import { createEnvelope, Envelope, Evidence, GitworthyError } from './envelope.js';
import { org_scan } from './org-scan.js';
import { scan } from './scan.js';
import { SkillProfile } from './skill-fit.js';
import { worth_check } from './worth-check.js';
import { toCheckResult } from '../contracts/serialize.js';
import { persistCheckResultBestEffort } from '../lib/store.js';

type Input = {
  repo?: string;
  org?: string;
  label?: string;
  keywords?: string[];
  since?: string;
  scan_limit?: number;
  max_repos?: number;
  max_checks?: number;
  land_hints?: boolean;
  skip_likely_land_only?: boolean;
  skip_soft_ask?: boolean;
  skip_assigned?: boolean;
  skip_ledger_skip?: boolean;
  skip_policy_gate?: boolean;
  npm_package?: string;
  skill_profile?: SkillProfile | string;
  capture_persist_checks?: boolean;
};

type PolicyGate = { blocked: boolean; claimRequired: boolean; feedbackChannel?: string };

type HuntCandidate = {
  number: number;
  repo?: string;
  quality_score: number;
  fit_score?: number;
  likely_land_only: boolean;
  land_hint?: string;
  soft_ask: boolean;
  assignees: string[];
};

const DEFAULT_SCAN_LIMIT = 25;
const DEFAULT_MAX_CHECKS = 3;
const MAX_MAX_CHECKS = 5;
const HUNT_LIMIT = 'hunt is a triage orchestrator, not a verdict: it chains scan/org_scan candidate discovery into serial worth_check calls and returns no signals of its own. Inspect each evidence.hunt_candidate.worth_check.verdict and .disposition individually before acting.';

function toHuntCandidate(item: Evidence): HuntCandidate | null {
  if (typeof item.number !== 'number') return null;
  return {
    number: item.number,
    repo: typeof item.repo === 'string' ? item.repo : undefined,
    quality_score: typeof item.quality_score === 'number' ? item.quality_score : 0,
    fit_score: typeof item.fit_score === 'number' ? item.fit_score : undefined,
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

export async function hunt(input: Input): Promise<Envelope> {
  if (!input.repo && !input.org) {
    throw new GitworthyError({
      code: 'hunt_invalid_input',
      message: 'hunt requires either repo or org.',
      not_checked: ['hunt requires either repo or org; neither was provided.']
    });
  }

  const scanLimit = Number.isFinite(input.scan_limit) ? Math.max(1, input.scan_limit as number) : DEFAULT_SCAN_LIMIT;
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

  const scanResult = useOrgMode
    ? await org_scan({
      org: input.org!,
      label: input.label,
      keywords: input.keywords,
      since: input.since,
      limit: scanLimit,
      max_repos: input.max_repos,
      land_hints: input.land_hints,
      skill_profile: input.skill_profile
    })
    : await scan({
      repo: input.repo!,
      label: input.label,
      keywords: input.keywords,
      since: input.since,
      limit: scanLimit,
      land_hints: input.land_hints,
      skill_profile: input.skill_profile
    });

  const scanCandidates = scanResult.evidence.map(toHuntCandidate).filter((item): item is HuntCandidate => item !== null);
  const { eligible, filteredCount, reasonCounts } = await filterCandidates(scanCandidates, input);
  // scan/org_scan already order by quality_score then fit_score when a skill_profile is present;
  // re-applying the same comparator here is a stable no-op in that case and only matters if the
  // upstream ordering didn't carry fit_score (e.g. future callers), so ties still prefer fit.
  const ordered = [...eligible].sort((left, right) =>
    right.quality_score - left.quality_score || (right.fit_score ?? 0) - (left.fit_score ?? 0)
  );

  const evidence: Evidence[] = [];
  const dispositionCounts = new Map<string, number>();
  const checked: string[] = [
    useOrgMode ? `ran org_scan for ${input.org}` : `ran scan for ${input.repo}`,
    ...(useOrgMode && input.repo ? ['both repo and org were provided; org took precedence for candidate discovery.'] : []),
    `discovered ${scanCandidates.length} scan candidate${scanCandidates.length === 1 ? '' : 's'}`,
    `applied hunt filters (skip_likely_land_only=${input.skip_likely_land_only !== false}, skip_soft_ask=${input.skip_soft_ask !== false}, skip_assigned=${input.skip_assigned !== false}, skip_ledger_skip=${input.skip_ledger_skip !== false}): ${eligible.length} eligible, ${filteredCount} filtered`,
    `will run up to ${maxChecks} worth_check(s) from ${eligible.length} eligible candidate(s), backfilling past policy-blocked repos`,
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

  while (queue.length > 0) {
    if (checksRun >= maxChecks) {
      deferred.push(...queue);
      break;
    }
    const candidate = queue.shift()!;
    const repo = candidate.repo ?? input.repo!;
    if (!skipPolicyGate) {
      if (!policyGate.has(repo)) {
        const evaluated = await evaluatePolicyGate([repo], evidence, checked, notCheckedSet);
        for (const [key, value] of evaluated) policyGate.set(key, value);
      }
      if (policyGate.get(repo)?.blocked) {
        policyBlockedCount += 1;
        continue;
      }
    }
    const result = await worth_check({ repo, issue_number: candidate.number, npm_package: input.npm_package });
    const capturedCheck = input.capture_persist_checks === true
      ? toCheckResult(result as unknown as Record<string, unknown>, { repo, issue_number: candidate.number })
      : undefined;
    if (capturedCheck) {
      await persistCheckResultBestEffort(capturedCheck);
    }
    checksRun += 1;
    dispositionCounts.set(result.disposition, (dispositionCounts.get(result.disposition) ?? 0) + 1);
    evidence.push({
      kind: 'hunt_candidate',
      repo,
      issue_number: candidate.number,
      quality_score: candidate.quality_score,
      ...(candidate.fit_score !== undefined ? { fit_score: candidate.fit_score } : {}),
      ...(candidate.land_hint ? { land_hint: candidate.land_hint } : {}),
      worth_check: {
        verdict: result.verdict,
        disposition: result.disposition,
        reasons: result.reasons,
        ...(capturedCheck ? { run_id: capturedCheck.run_id, decision_id: capturedCheck.decision_id } : {})
      }
    });
    checked.push(`worth_check ${repo}#${candidate.number} -> ${result.verdict}/${result.disposition} (checked: ${result.checked.join(', ') || 'none'})`);
    result.not_checked.forEach((item) => notCheckedSet.add(item));
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

  const dispositionSummary = dispositionCounts.size > 0
    ? [...dispositionCounts.entries()].map(([disposition, count]) => `${disposition} x${count}`).join(', ')
    : 'none (no candidates checked)';

  return createEnvelope({
    verdict_summary: `hunted ${checksRun} check${checksRun === 1 ? '' : 's'} from ${scanCandidates.length} scan candidate${scanCandidates.length === 1 ? '' : 's'} (${filteredCount} filtered${policyBlockedCount > 0 ? `, ${policyBlockedCount} policy-blocked` : ''}); dispositions: ${dispositionSummary}`,
    evidence,
    checked,
    not_checked: [...notCheckedSet],
    cached: false
  });
}
