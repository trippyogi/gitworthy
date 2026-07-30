import { getLedgerEntry } from '../lib/ledger.js';
import { createEnvelope, Envelope, Evidence, GitworthyError } from './envelope.js';
import { org_scan } from './org-scan.js';
import { scan } from './scan.js';
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
  land_hints?: boolean;
  skip_likely_land_only?: boolean;
  skip_soft_ask?: boolean;
  skip_assigned?: boolean;
  skip_ledger_skip?: boolean;
  npm_package?: string;
};

type HuntCandidate = {
  number: number;
  repo?: string;
  quality_score: number;
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
      land_hints: input.land_hints
    })
    : await scan({
      repo: input.repo!,
      label: input.label,
      keywords: input.keywords,
      since: input.since,
      limit: scanLimit,
      land_hints: input.land_hints
    });

  const scanCandidates = scanResult.evidence.map(toHuntCandidate).filter((item): item is HuntCandidate => item !== null);
  const { eligible, filteredCount, reasonCounts } = await filterCandidates(scanCandidates, input);
  const selected = eligible.slice(0, maxChecks);
  const deferred = eligible.slice(maxChecks);

  const evidence: Evidence[] = [];
  const dispositionCounts = new Map<string, number>();
  const checked: string[] = [
    useOrgMode ? `ran org_scan for ${input.org}` : `ran scan for ${input.repo}`,
    ...(useOrgMode && input.repo ? ['both repo and org were provided; org took precedence for candidate discovery.'] : []),
    `discovered ${scanCandidates.length} scan candidate${scanCandidates.length === 1 ? '' : 's'}`,
    `applied hunt filters (skip_likely_land_only=${input.skip_likely_land_only !== false}, skip_soft_ask=${input.skip_soft_ask !== false}, skip_assigned=${input.skip_assigned !== false}, skip_ledger_skip=${input.skip_ledger_skip !== false}): ${eligible.length} eligible, ${filteredCount} filtered`,
    `selected top ${selected.length} of ${eligible.length} eligible candidate(s) by quality_score (max_checks=${maxChecks})`,
    ...scanResult.checked
  ];
  const notCheckedSet = new Set<string>(scanResult.not_checked);

  for (const candidate of selected) {
    const repo = candidate.repo ?? input.repo!;
    const result = await worth_check({ repo, issue_number: candidate.number, npm_package: input.npm_package });
    dispositionCounts.set(result.disposition, (dispositionCounts.get(result.disposition) ?? 0) + 1);
    evidence.push({
      kind: 'hunt_candidate',
      repo,
      issue_number: candidate.number,
      quality_score: candidate.quality_score,
      ...(candidate.land_hint ? { land_hint: candidate.land_hint } : {}),
      worth_check: {
        verdict: result.verdict,
        disposition: result.disposition,
        reasons: result.reasons
      }
    });
    checked.push(`worth_check ${repo}#${candidate.number} -> ${result.verdict}/${result.disposition} (checked: ${result.checked.join(', ') || 'none'})`);
    result.not_checked.forEach((item) => notCheckedSet.add(item));
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
    verdict_summary: `hunted ${selected.length} check${selected.length === 1 ? '' : 's'} from ${scanCandidates.length} scan candidate${scanCandidates.length === 1 ? '' : 's'} (${filteredCount} filtered); dispositions: ${dispositionSummary}`,
    evidence,
    checked,
    not_checked: [...notCheckedSet],
    cached: false
  });
}
