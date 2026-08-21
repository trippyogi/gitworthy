import {
  RoutingDecisionSchema,
  type BuildContention,
  type ContributionMode,
  type EffortBucket,
  type Evidenceability,
  type ReproHint,
  type RouteFacts,
  type RoutingConfidence,
  type RoutingDecision
} from '../contracts/routing.js';

const STALE_SNAPSHOT_MS = 48 * 60 * 60 * 1000;

const SALVAGE_CONSTRAINTS = [
  'coordinate_before_upstream_action',
  'preserve_attribution',
  'verify_current_main'
] as const;

function hasFinding(facts: RouteFacts, type: string): boolean {
  return facts.findings.some((item) => item.type === type);
}

function hasDefinitiveFinding(facts: RouteFacts, type: string): boolean {
  return facts.findings.some((item) => item.type === type && item.strength === 'definitive');
}

function hasHeuristicOnlyTitleOverlap(facts: RouteFacts): boolean {
  const titleOverlap = facts.findings.some((item) => item.type === 'title_overlap_pr');
  if (!titleOverlap) return false;
  return !hasDefinitiveFinding(facts, 'linked_pr_open') && facts.linked.activeClosers === 0;
}

function failedMandatory(facts: RouteFacts): boolean {
  return facts.mandatoryFailures.length > 0
    || facts.coverage.failed_checks.length > 0
    || hasFinding(facts, 'mandatory_check_failed');
}

function providersIncomplete(facts: RouteFacts): boolean {
  return facts.coverage.mandatory_checks_complete === false || failedMandatory(facts);
}

function snapshotStale(facts: RouteFacts): boolean {
  const age = facts.coverage.snapshot_age_ms;
  return typeof age === 'number' && age > STALE_SNAPSHOT_MS;
}

function explicitActiveClosers(facts: RouteFacts): number {
  if (facts.linked.activeClosers > 0) return facts.linked.activeClosers;
  if (facts.disposition === 'land_only' || hasDefinitiveFinding(facts, 'linked_pr_open')) {
    const siblings = facts.findings.filter((item) => item.type === 'competing_open_closer').length;
    return 1 + siblings;
  }
  return 0;
}

function assignedOrClaimed(facts: RouteFacts): boolean {
  return facts.linked.assigned
    || facts.linked.claimRequired
    || facts.disposition === 'claim_first'
    || hasFinding(facts, 'assigned')
    || hasFinding(facts, 'claim_required');
}

function releasedFix(facts: RouteFacts): boolean {
  return hasDefinitiveFinding(facts, 'released_fix');
}

function noPrPath(facts: RouteFacts): boolean {
  return hasFinding(facts, 'no_pr_path');
}

function fullyResolved(facts: RouteFacts): boolean {
  return facts.linked.fullyResolved === true;
}

function needsRepro(facts: RouteFacts): boolean {
  if (hasFinding(facts, 'needs_repro')) return true;
  const quality = facts.quality;
  if (!quality?.looksLikeBug) return false;
  return quality.repro === 'missing' || quality.repro === 'weak';
}

function maintainerAssistOpenCloser(facts: RouteFacts): boolean {
  return explicitActiveClosers(facts) > 0 || facts.disposition === 'land_only';
}

function hardNonWork(facts: RouteFacts): boolean {
  if (maintainerAssistOpenCloser(facts)) return false;
  if (releasedFix(facts) || noPrPath(facts) || fullyResolved(facts)) return true;
  return facts.verdict === 'SKIP' && facts.disposition === 'blocked';
}

function salvageQualified(facts: RouteFacts): boolean {
  const issueOpen = facts.linked.issueOpen !== false;
  const closedCredible = facts.linked.closedUnmergedAttempts > 0
    && facts.linked.substantivePriorAttempt === true
    && issueOpen;
  const staleRevivable = facts.linked.staleOpenPr === true
    && facts.linked.maintainerInterest === true
    && facts.linked.credibleWorkRemains === true;
  return closedCredible || staleRevivable;
}

function ambiguousPriorAttempt(facts: RouteFacts): boolean {
  return (facts.linked.closedUnmergedAttempts > 0 || hasFinding(facts, 'linked_pr_closed'))
    && !salvageQualified(facts);
}

function buildEligible(facts: RouteFacts, contention: BuildContention): boolean {
  return facts.verdict === 'ACT'
    && facts.disposition === 'greenfield'
    && contention === 'GREEN'
    && !failedMandatory(facts)
    && !assignedOrClaimed(facts)
    && !needsRepro(facts);
}

export function scoreEvidenceability(quality?: RouteFacts['quality']): Evidenceability {
  const reasons: string[] = [];
  const repro: ReproHint | undefined = quality?.repro;
  if (repro === 'present') {
    reasons.push('repro present');
    return { score: 0.9, reasons };
  }
  if (repro === 'weak') {
    reasons.push('weak repro');
    return { score: 0.6, reasons };
  }
  if (quality?.looksLikeBug) {
    reasons.push('looks_like_bug without repro');
    return { score: 0.3, reasons };
  }
  reasons.push('no bug/repro signal');
  return { score: 0.5, reasons };
}

function computeContention(facts: RouteFacts): BuildContention {
  if (hasHeuristicOnlyTitleOverlap(facts) && explicitActiveClosers(facts) === 0 && facts.linked.mergedClosers === 0 && !fullyResolved(facts)) {
    return 'YELLOW';
  }
  if (explicitActiveClosers(facts) > 0 || facts.linked.mergedClosers > 0 || fullyResolved(facts) || releasedFix(facts)) {
    return 'RED';
  }
  if (
    assignedOrClaimed(facts)
    || facts.linked.activeRelatedPrs > 0
    || facts.linked.staleOpenPr === true
    || hasFinding(facts, 'linked_pr_mention')
    || hasFinding(facts, 'title_overlap_pr')
    || hasFinding(facts, 'branch_match')
    || facts.contention?.low_confidence === true
    || facts.contention?.state === 'contested'
    || providersIncomplete(facts)
    || facts.coverage.advisory_missing.length > 0
  ) {
    return 'YELLOW';
  }
  return 'GREEN';
}

function computeConfidence(facts: RouteFacts, heuristicPrimary: boolean): RoutingConfidence {
  if (
    failedMandatory(facts)
    || facts.coverage.budget_truncated
    || facts.coverage.rate_limit_degraded
    || snapshotStale(facts)
    || !facts.coverage.mandatory_checks_complete
  ) {
    return 'low';
  }
  if (heuristicPrimary || facts.coverage.advisory_missing.length > 0 || facts.contention?.low_confidence === true) {
    return 'medium';
  }
  return 'high';
}

function effortFor(mode: ContributionMode): EffortBucket {
  switch (mode) {
    case 'DOC':
      return 'fast';
    case 'REVIEW':
    case 'REPRODUCE':
      return 'medium';
    case 'SALVAGE':
      return 'deep';
    case 'EVAL':
      return 'research';
    default:
      return 'unknown';
  }
}

function alternate(
  mode: ContributionMode,
  score: number,
  reason: string
): RoutingDecision['alternate_modes'][number] {
  return { mode, score, reason };
}

type ModePick = {
  primary: ContributionMode;
  alternates: RoutingDecision['alternate_modes'];
  reasons: string[];
  nextActions: RoutingDecision['next_actions'];
  constraints: string[];
  heuristicPrimary: boolean;
};

function pickMode(facts: RouteFacts, contention: BuildContention): ModePick {
  const constraints: string[] = [];
  const closers = explicitActiveClosers(facts);

  if (contention === 'RED' || failedMandatory(facts) || assignedOrClaimed(facts) || releasedFix(facts) || noPrPath(facts) || fullyResolved(facts)) {
    constraints.push('suppress_build');
  }

  if (hardNonWork(facts)) {
    if (releasedFix(facts)) constraints.push('released_fix');
    if (noPrPath(facts)) constraints.push('no_pr_path');
    if (fullyResolved(facts)) constraints.push('fully_resolved');
    const reasons = ['No active contribution effort is justified from this state.'];
    if (releasedFix(facts)) reasons.push('Definitive released_fix evidence.');
    if (noPrPath(facts)) reasons.push('Repository policy has no PR path.');
    if (fullyResolved(facts)) reasons.push('Implementation is fully resolved.');
    if (facts.verdict === 'SKIP' && facts.disposition === 'blocked') {
      reasons.push('SKIP / blocked is hard non-work.');
    }
    return {
      primary: 'PASS',
      alternates: [],
      reasons,
      nextActions: [{ kind: 'pass', message: 'No active contribution effort is justified. Retain the snapshot and reevaluate if target state changes.' }],
      constraints,
      heuristicPrimary: false
    };
  }

  if (closers > 0 || facts.disposition === 'land_only') {
    constraints.push('active_closer');
    if (closers > 1) constraints.push('multiple_closers');
    const healthy = closers === 1 && facts.linked.healthyActiveCloser === true;
    if (healthy) {
      return {
        primary: 'WATCH',
        alternates: [alternate('REVIEW', 0.6, 'Internal review if CI, gaps, or author activity change.')],
        reasons: [
          'A healthy active closer already owns implementation; do not start parallel BUILD.',
          'WATCH until PR health or ownership changes.'
        ],
        nextActions: [{
          kind: 'watch',
          message: 'Reevaluate if the closing PR becomes stale, is closed, loses maintainer review, or CI/review status changes.'
        }],
        constraints,
        heuristicPrimary: false
      };
    }
    const reasons = closers > 1
      ? ['Multiple active closers; determine which implementation should land or whether they cover distinct failure classes.']
      : ['An explicit open closer already owns the implementation; REVIEW means internal review/evidence, not posting comments.'];
    if (facts.disposition === 'land_only') {
      reasons.push('SKIP / land_only is maintainer-assist, not PASS.');
    }
    return {
      primary: 'REVIEW',
      alternates: [alternate('WATCH', 0.45, 'Watch if later enrichment shows a healthy actively reviewed closer.')],
      reasons,
      nextActions: [{
        kind: 'review',
        message: closers > 1
          ? 'Review competing closers internally and decide which should land. Do not open a parallel implementation.'
          : 'Review or help land the open closer internally. Do not open a parallel implementation.'
      }],
      constraints,
      heuristicPrimary: false
    };
  }

  if (salvageQualified(facts)) {
    constraints.push(...SALVAGE_CONSTRAINTS);
    return {
      primary: 'SALVAGE',
      alternates: [alternate('REVIEW', 0.55, 'Review the prior attempt if salvage coordination is blocked.')],
      reasons: [
        'Credible prior implementation remains useful and the issue is still open.',
        'SALVAGE requires coordinating before any upstream action, preserving original attribution, and verifying current main.'
      ],
      nextActions: [
        { kind: 'coordinate', message: 'Coordinate before any upstream action on the prior attempt.' },
        { kind: 'salvage', message: 'Preserve original attribution and verify the work against current main before reviving it.' }
      ],
      constraints,
      heuristicPrimary: false
    };
  }

  if (ambiguousPriorAttempt(facts) || (facts.linked.staleOpenPr === true && !salvageQualified(facts))) {
    return {
      primary: 'REVIEW',
      alternates: [alternate('WATCH', 0.4, 'Watch if the prior attempt lacks enough evidence to act.')],
      reasons: [
        'A closed unmerged or stale prior attempt exists, but evidence is not strong enough for SALVAGE.',
        'Age or inactivity alone is not abandonment.'
      ],
      nextActions: [{
        kind: 'review',
        message: 'Read the prior attempt and verify current main before deciding whether revival is warranted.'
      }],
      constraints,
      heuristicPrimary: true
    };
  }

  if (needsRepro(facts) && (facts.verdict === 'VERIFY' || facts.verdict === 'ACT')) {
    return {
      primary: 'REPRODUCE',
      alternates: [alternate('WATCH', 0.35, 'Watch if a repro cannot be gathered yet.')],
      reasons: [
        'Bug-shaped issue lacks sufficient proof it still fails on current main.',
        'Routing will not promote weak or missing proof to BUILD.'
      ],
      nextActions: [{
        kind: 'reproduce',
        message: 'Reproduce the failure on current main before any implementation work.'
      }],
      constraints,
      heuristicPrimary: !hasDefinitiveFinding(facts, 'needs_repro')
    };
  }

  if (assignedOrClaimed(facts)) {
    constraints.push('claim_unresolved');
    return {
      primary: 'WATCH',
      alternates: [alternate('REVIEW', 0.3, 'Review only after ownership is resolved.')],
      reasons: ['Ownership is unresolved (assignment or claim protocol). Do not recommend BUILD.'],
      nextActions: [{
        kind: 'coordinate',
        message: 'Coordinate or satisfy the repository claim protocol. Reevaluate when assignment is released or the claim is satisfied.'
      }],
      constraints,
      heuristicPrimary: false
    };
  }

  if (facts.linked.mergedClosers > 0) {
    constraints.push('merged_closer');
    return {
      primary: 'REVIEW',
      alternates: [alternate('PASS', 0.35, 'PASS if remaining work is confirmed none.')],
      reasons: ['A merged closer exists while the issue may still be open; confirm remaining work.'],
      nextActions: [{
        kind: 'review',
        message: 'Confirm remaining work after the merged closer, then close or retarget the issue.'
      }],
      constraints,
      heuristicPrimary: false
    };
  }

  if (buildEligible(facts, contention)) {
    if (facts.categoryHints?.evaluation) {
      return {
        primary: 'EVAL',
        alternates: [alternate('WATCH', 0.3, 'Watch if the eval source is not yet actionable.')],
        reasons: ['Source-driven evaluation/benchmark task; not an ordinary implementation issue.'],
        nextActions: [{ kind: 'evaluate', message: 'Investigate the eval or benchmark anomaly. Reevaluate if the source report is withdrawn.' }],
        constraints,
        heuristicPrimary: false
      };
    }
    if (facts.categoryHints?.documentation) {
      return {
        primary: 'DOC',
        alternates: [alternate('WATCH', 0.25, 'Watch if documentation scope is unclear.')],
        reasons: ['Target is clearly documentation-only and otherwise actionable.'],
        nextActions: [{ kind: 'document', message: 'Make the documentation-only change. Do not expand into unrelated implementation.' }],
        constraints,
        heuristicPrimary: false
      };
    }
    return {
      primary: 'BUILD',
      alternates: [
        alternate('REVIEW', 0.25, 'Re-check evidence before a public action.'),
        alternate('WATCH', 0.2, 'Watch if execution-time recheck finds new ownership.')
      ],
      reasons: [
        'ACT / greenfield with GREEN contention; no active ownership detected.',
        'BUILD is not a publish gate; re-check immediately before any public action.'
      ],
      nextActions: [{
        kind: 'proceed',
        message: 'Implementation is the recommended contribution. Re-check immediately before a public action.'
      }],
      constraints,
      heuristicPrimary: false
    };
  }

  if (hasFinding(facts, 'branch_match')) {
    return {
      primary: 'WATCH',
      alternates: [alternate('REVIEW', 0.4, 'Review if the branch evidence becomes more than heuristic.')],
      reasons: ['Weak in-flight branch evidence; state is likely to change. Heuristic overlap is not definitive ownership.'],
      nextActions: [{
        kind: 'watch',
        message: 'Reevaluate when the matching branch is merged, abandoned, or the issue closes.'
      }],
      constraints,
      heuristicPrimary: true
    };
  }

  if (providersIncomplete(facts) || facts.coverage.advisory_missing.length > 0) {
    return {
      primary: 'WATCH',
      alternates: [alternate('REVIEW', 0.35, 'Review available evidence if a human must interpret gaps now.')],
      reasons: ['Evidence is currently insufficient or a required provider did not complete.'],
      nextActions: [{
        kind: 'watch',
        message: 'Reevaluate when failed or skipped mandatory checks complete, or when missing advisory sources become available.'
      }],
      constraints,
      heuristicPrimary: true
    };
  }

  if (facts.verdict === 'SKIP') {
    return {
      primary: 'PASS',
      alternates: [],
      reasons: ['SKIP without a maintainer-assist path; no active contribution effort is justified.'],
      nextActions: [{ kind: 'pass', message: 'No active contribution effort is justified. Reevaluate if target state changes.' }],
      constraints,
      heuristicPrimary: false
    };
  }

  if (facts.verdict === 'VERIFY' || facts.disposition === 'crowded' || facts.disposition === 'review') {
    const heuristic = hasFinding(facts, 'lexical_duplicate')
      || hasFinding(facts, 'path_or_content_overlap')
      || hasFinding(facts, 'title_overlap_pr')
      || hasFinding(facts, 'linked_pr_mention');
    return {
      primary: 'REVIEW',
      alternates: [alternate('WATCH', 0.4, 'Watch if the remaining uncertainty is expected to resolve without intervention.')],
      reasons: ['Verification or prior-attempt inspection is the justified contribution; do not treat this as BUILD.'],
      nextActions: [{
        kind: 'review',
        message: 'Perform the named verification internally before investing in implementation.'
      }],
      constraints,
      heuristicPrimary: heuristic
    };
  }

  return {
    primary: 'WATCH',
    alternates: [alternate('REVIEW', 0.3, 'Review if a human must interpret remaining uncertainty now.')],
    reasons: ['Insufficient evidence to justify active contribution; retain and reevaluate on state change.'],
    nextActions: [{
      kind: 'watch',
      message: 'Reevaluate when target state, linked work, or mandatory checks change.'
    }],
    constraints,
    heuristicPrimary: true
  };
}

/** Pure contribution-mode policy. Consumes normalized facts; never calls GitHub; never mutates verdict. */
export function routeContribution(facts: RouteFacts): RoutingDecision {
  const contention = computeContention(facts);
  const evidenceability = scoreEvidenceability(facts.quality);
  const picked = pickMode(facts, contention);
  let primary = picked.primary;
  const constraints = [...picked.constraints];

  if (primary === 'BUILD' && (contention === 'RED' || constraints.includes('suppress_build') || failedMandatory(facts))) {
    primary = 'WATCH';
    constraints.push('suppress_build');
    picked.reasons.push('BUILD suppressed by hard constraint; routing does not upgrade certainty.');
    picked.nextActions = [{
      kind: 'watch',
      message: 'Reevaluate when ownership, failed checks, or definitive blockers change.'
    }];
  }

  const confidence = computeConfidence(facts, picked.heuristicPrimary);
  if (primary === 'BUILD' && confidence === 'low') {
    primary = 'WATCH';
    picked.reasons.push('Low confidence cannot recommend BUILD.');
    picked.nextActions = [{
      kind: 'watch',
      message: 'Reevaluate when mandatory providers complete and the snapshot is fresh.'
    }];
  }

  const uniqueConstraints = [...new Set(constraints)];
  const alternates = picked.alternates.filter((item) => item.mode !== primary);
  if (uniqueConstraints.includes('suppress_build')) {
    for (const item of alternates) {
      if (item.mode === 'BUILD') item.score = 0;
    }
  }

  return RoutingDecisionSchema.parse({
    routing_version: 1,
    primary_mode: primary,
    alternate_modes: uniqueConstraints.includes('suppress_build')
      ? alternates.filter((item) => item.mode !== 'BUILD' || item.score > 0)
      : alternates,
    build_contention: contention,
    confidence,
    reasons: picked.reasons,
    hard_constraints: uniqueConstraints,
    next_actions: picked.nextActions,
    evidenceability,
    effort_bucket: effortFor(primary),
    coverage: facts.coverage
  });
}
