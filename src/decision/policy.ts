import type { Finding, FindingEffect, FindingStrength } from '../contracts/findings.js';
import { newFindingId } from '../contracts/common.js';
import type { Signal } from '../core/envelope.js';

export type DecisionVerdict = 'ACT' | 'VERIFY' | 'SKIP';
export type Disposition = 'greenfield' | 'land_only' | 'claim_first' | 'blocked' | 'crowded' | 'review';

type SubResult =
  | { name: string; ok: true; result: { signals?: Signal[]; evidence?: Array<Record<string, unknown>> } }
  | { name: string; ok: false; error: { code: string; message: string; not_checked: string[] } };

export type PolicyInput = {
  signals: Signal[];
  sub_results: SubResult[];
  errors: SubResult[];
  priorAttempts: number;
  referencedCommits: number;
  networkPrs: number;
};

export type PolicyDecision = {
  verdict: DecisionVerdict;
  disposition: Disposition;
  findings: Finding[];
  reasons: string[];
};

function finding(input: {
  type: string;
  strength: FindingStrength;
  effect: FindingEffect;
  source: string;
  message: string;
  url?: string;
  data?: Record<string, unknown>;
}): Finding {
  return {
    id: newFindingId(),
    type: input.type,
    strength: input.strength,
    effect: input.effect,
    source: input.source,
    message: input.message,
    url: input.url,
    data: input.data ?? {}
  };
}

function openLinkedPrs(subResults: SubResult[]): Array<Record<string, unknown>> {
  const linked = subResults.find((result) => result.ok && result.name === 'linked_work');
  if (!linked?.ok) return [];
  return (linked.result.evidence ?? []).filter((item) =>
    item.kind === 'linked_pr'
    && item.state === 'open'
    && item.ignored_reason !== 'automation_author'
    && item.ignored_reason !== 'draft_without_close'
    // Defensive: drafts without closes_issue must never become land_only even if still active.
    && !(item.draft === true && item.closes_issue !== true)
  );
}

function prRecency(pr: Record<string, unknown>): number {
  const raw = typeof pr.updated_at === 'string' ? pr.updated_at : typeof pr.date === 'string' ? pr.date : '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Prefer non-draft explicit closers, then most recently updated. */
function rankOpenClosers(closers: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...closers].sort((left, right) => {
    const draftDelta = Number(left.draft === true) - Number(right.draft === true);
    if (draftDelta !== 0) return draftDelta;
    return prRecency(right) - prRecency(left);
  });
}

function classifyLinkedOpen(subResults: SubResult[]): Finding[] {
  const opens = openLinkedPrs(subResults);
  if (opens.length === 0) return [];

  const explicitClosers = opens.filter((pr) => pr.closes_issue === true && pr.source !== 'title_overlap');
  if (explicitClosers.length > 0) {
    const ranked = rankOpenClosers(explicitClosers);
    const primary = ranked[0];
    const number = typeof primary.number === 'number' ? primary.number : undefined;
    const findings: Finding[] = [finding({
      type: 'linked_pr_open',
      strength: 'definitive',
      effect: 'block',
      source: 'github_pull_request',
      message: number ? `PR #${number} explicitly closes the issue.` : 'An open PR explicitly closes the issue.',
      url: typeof primary.url === 'string' ? primary.url : undefined,
      data: {
        number,
        source: primary.source,
        closes_issue: true,
        draft: primary.draft === true,
        land_pick: true,
        competing_closers: ranked.slice(1).map((pr) => pr.number).filter((value) => typeof value === 'number')
      }
    })];
    for (const sibling of ranked.slice(1)) {
      const siblingNumber = typeof sibling.number === 'number' ? sibling.number : undefined;
      findings.push(finding({
        type: 'competing_open_closer',
        strength: 'corroborated',
        effect: 'inform',
        source: 'github_pull_request',
        message: siblingNumber && number
          ? `Competing open closer #${siblingNumber}; prefer landing #${number} and closing or retargeting siblings.`
          : 'Another open PR also claims to close this issue; prefer the land-pick primary.',
        url: typeof sibling.url === 'string' ? sibling.url : undefined,
        data: { number: siblingNumber, primary: number, source: sibling.source, closes_issue: true }
      }));
    }
    return findings;
  }

  const nonTitle = opens.find((pr) => pr.source !== 'title_overlap');
  if (nonTitle) {
    const number = typeof nonTitle.number === 'number' ? nonTitle.number : undefined;
    return [finding({
      type: 'linked_pr_mention',
      strength: 'corroborated',
      effect: 'verify',
      source: 'github_pull_request',
      message: number ? `Open PR #${number} mentions the issue without an explicit closing relationship.` : 'An open PR mentions the issue without an explicit closing relationship.',
      url: typeof nonTitle.url === 'string' ? nonTitle.url : undefined,
      data: { number, source: nonTitle.source, closes_issue: false }
    })];
  }

  const titleOnly = opens[0];
  const number = typeof titleOnly.number === 'number' ? titleOnly.number : undefined;
  return [finding({
    type: 'title_overlap_pr',
    strength: 'heuristic',
    effect: 'verify',
    source: 'github_pull_request_search',
    message: number ? `Open PR #${number} matched by title overlap only.` : 'An open PR matched by title overlap only.',
    url: typeof titleOnly.url === 'string' ? titleOnly.url : undefined,
    data: { number, source: 'title_overlap' }
  })];
}

function findingsForSignal(signal: Signal, subResults: SubResult[]): Finding[] {
  switch (signal) {
    case 'linked_pr_open': {
      const classified = classifyLinkedOpen(subResults);
      if (classified.length > 0) return classified;
      // Without classified evidence, do not invent a definitive blocker.
      return [finding({
        type: 'linked_pr_open_unclassified',
        strength: 'heuristic',
        effect: 'verify',
        source: 'linked_work',
        message: 'Open linked PR signal present without classified evidence; verify before investing.'
      })];
    }
    case 'duplicate':
      return [finding({
        type: 'lexical_duplicate',
        strength: 'heuristic',
        effect: 'verify',
        source: 'dupe_cluster',
        message: 'High lexical duplicate score found; confirm whether GitHub/maintainer marked a duplicate.'
      })];
    case 'shipped':
      return [finding({
        type: 'path_or_content_overlap',
        strength: 'heuristic',
        effect: 'verify',
        source: 'issue_vs_main',
        message: 'Path/content overlap on main is heuristic; verify the requested behavior is implemented.'
      })];
    case 'in_flight':
      return [finding({
        type: 'branch_match',
        strength: 'heuristic',
        effect: 'verify',
        source: 'branch_scan',
        message: 'Matching branch names are heuristic; they cannot hard-block by themselves.'
      })];
    case 'released_fix':
      return [finding({
        type: 'released_fix',
        strength: 'definitive',
        effect: 'block',
        source: 'release_gap',
        message: 'Exact issue-specific probe matched in the published artifact.'
      })];
    case 'no_pr_path':
      return [finding({
        type: 'no_pr_path',
        strength: 'definitive',
        effect: 'verify',
        source: 'contrib_policy',
        message: 'Repository policy rejects pull requests; use the stated alternate channel.'
      })];
    case 'claim_required':
      return [finding({
        type: 'claim_required',
        strength: 'definitive',
        effect: 'verify',
        source: 'contrib_policy',
        message: 'Contribution policy requires claiming or assignment before a PR.'
      })];
    case 'assigned':
      return [finding({
        type: 'assigned',
        strength: 'definitive',
        effect: 'verify',
        source: 'linked_work',
        message: 'Issue is assigned; coordinate before acting.'
      })];
    case 'linked_pr_merged':
      return [finding({
        type: 'close_candidate',
        strength: 'definitive',
        effect: 'verify',
        source: 'linked_work',
        message: 'CLOSE_CANDIDATE: a linked PR was merged while the issue remains open — confirm remaining work, then close or retarget the issue.'
      })];
    case 'linked_pr_closed':
      return [finding({
        type: 'linked_pr_closed',
        strength: 'definitive',
        effect: 'verify',
        source: 'linked_work',
        message: 'A linked PR was closed unmerged; read the prior attempt before retrying.'
      })];
    case 'needs_repro':
      return [finding({
        type: 'needs_repro',
        strength: 'heuristic',
        effect: 'verify',
        source: 'issue_vs_main',
        message: 'Bug-shaped issue lacks reproduction steps.'
      })];
    default:
      return [finding({
        type: signal,
        strength: 'heuristic',
        effect: 'verify',
        source: 'unknown',
        message: `Unrecognized signal ${signal} capped at VERIFY.`
      })];
  }
}

function chooseDisposition(input: {
  verdict: DecisionVerdict;
  findings: Finding[];
  priorAttempts: number;
  referencedCommits: number;
  networkPrs: number;
}): Disposition {
  const types = new Set(input.findings.map((item) => item.type));
  if (input.findings.some((item) => item.effect === 'block' && item.strength === 'definitive' && item.type === 'released_fix')) return 'blocked';
  if (types.has('linked_pr_open')) return 'land_only';
  if (types.has('assigned') || types.has('claim_required')) return 'claim_first';
  if (types.has('no_pr_path')) return 'blocked';
  if (input.priorAttempts >= 2 || input.referencedCommits + input.networkPrs >= 3) return 'crowded';
  if (input.verdict === 'ACT') return 'greenfield';
  return 'review';
}

/** Map provider signals + evidence into typed findings and a safe verdict. Heuristics never independently SKIP. */
export function decideFromSignals(input: PolicyInput): PolicyDecision {
  const findings: Finding[] = [];
  const reasons: string[] = [];

  for (const result of input.sub_results) {
    if (!result.ok) reasons.push(`${result.name} errored: ${result.error.message}`);
    if (result.ok && (result.result.signals ?? []).length > 0) {
      reasons.push(`${result.name}: ${(result.result.signals ?? []).join(', ')}`);
    }
  }

  for (const signal of input.signals) {
    findings.push(...findingsForSignal(signal, input.sub_results));
  }

  if (input.errors.length > 0) {
    findings.push(finding({
      type: 'mandatory_check_failed',
      strength: 'definitive',
      effect: 'verify',
      source: 'worth_check',
      message: 'A mandatory provider failed; capping at VERIFY.'
    }));
  }

  const hasDefinitiveBlock = findings.some((item) => item.effect === 'block' && item.strength === 'definitive');
  const hasVerify = findings.some((item) => item.effect === 'verify' || (item.effect === 'block' && item.strength !== 'definitive'));

  let verdict: DecisionVerdict = 'ACT';
  // Mandatory failures always win over definitive blockers (invariant: failed check ⇒ VERIFY).
  if (input.errors.length > 0) verdict = 'VERIFY';
  else if (hasDefinitiveBlock) verdict = 'SKIP';
  else if (hasVerify) verdict = 'VERIFY';

  if (verdict === 'SKIP' && !hasDefinitiveBlock) verdict = 'VERIFY';
  if (verdict === 'SKIP' && input.errors.length > 0) verdict = 'VERIFY';

  const disposition = chooseDisposition({
    verdict,
    findings,
    priorAttempts: input.priorAttempts,
    referencedCommits: input.referencedCommits,
    networkPrs: input.networkPrs
  });

  for (const item of findings.filter((findingItem) => findingItem.effect !== 'inform')) {
    reasons.push(`${item.strength}/${item.effect}: ${item.message}`);
  }

  return { verdict, disposition, findings, reasons };
}
