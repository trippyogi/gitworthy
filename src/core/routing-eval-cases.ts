import type { RoutingEvalCase } from '../contracts/routing-eval.js';
import type { RouteFacts } from '../contracts/routing.js';

const complete = {
  mandatory_checks_complete: true,
  failed_checks: [] as string[],
  skipped_checks: [] as string[],
  budget_truncated: false,
  rate_limit_degraded: false,
  advisory_missing: [] as string[]
};

function facts(partial: Partial<RouteFacts> & Pick<RouteFacts, 'verdict' | 'disposition' | 'linked'>): RouteFacts {
  return {
    findings: [],
    mandatoryFailures: [],
    coverage: complete,
    ...partial
  };
}

const reconstructedRoutingCaseDrafts: Array<Omit<RoutingEvalCase, 'adversarial'> & { adversarial?: boolean }> = [
  {
    id: 'recon-unoccupied-bug-build',
    name: 'Unoccupied clear bug → BUILD',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'ACT',
      disposition: 'greenfield',
      quality: { looksLikeBug: true, repro: 'present', softAsk: false },
      linked: { activeClosers: 0, activeRelatedPrs: 0, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false }
    }),
    expected: { primary_mode: 'BUILD', acceptable_modes: [], forbidden_modes: ['PASS'] }
  },
  {
    id: 'recon-missing-repro',
    name: 'Missing repro → REPRODUCE',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'VERIFY',
      disposition: 'greenfield',
      quality: { looksLikeBug: true, repro: 'missing', softAsk: false },
      linked: { activeClosers: 0, activeRelatedPrs: 0, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false }
    }),
    expected: { primary_mode: 'REPRODUCE', acceptable_modes: ['WATCH'], forbidden_modes: ['BUILD'] }
  },
  {
    id: 'recon-explicit-closer',
    name: 'Explicit closer → REVIEW',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'SKIP',
      disposition: 'land_only',
      findings: [{ id: '1', type: 'linked_pr_open', strength: 'definitive', effect: 'block', source: 'test', message: 'closer', data: {} }],
      linked: { activeClosers: 1, activeRelatedPrs: 1, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false, healthyActiveCloser: false }
    }),
    expected: { primary_mode: 'REVIEW', acceptable_modes: ['WATCH'], forbidden_modes: ['BUILD'] }
  },
  {
    id: 'recon-multiple-closers',
    name: 'Multiple closers → REVIEW',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'SKIP',
      disposition: 'land_only',
      findings: [{ id: '1', type: 'linked_pr_open', strength: 'definitive', effect: 'block', source: 'test', message: 'closer', data: {} }],
      linked: { activeClosers: 2, activeRelatedPrs: 2, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false }
    }),
    expected: { primary_mode: 'REVIEW', acceptable_modes: [], forbidden_modes: ['BUILD'] }
  },
  {
    id: 'recon-healthy-active-pr',
    name: 'Healthy active PR → WATCH',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'SKIP',
      disposition: 'land_only',
      findings: [{ id: '1', type: 'linked_pr_open', strength: 'definitive', effect: 'block', source: 'test', message: 'closer', data: {} }],
      linked: { activeClosers: 1, activeRelatedPrs: 1, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false, healthyActiveCloser: true }
    }),
    expected: { primary_mode: 'WATCH', acceptable_modes: ['REVIEW'], forbidden_modes: ['BUILD'] }
  },
  {
    id: 'recon-closed-unmerged',
    name: 'Closed unmerged credible → SALVAGE or REVIEW',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'VERIFY',
      disposition: 'review',
      linked: {
        activeClosers: 0, activeRelatedPrs: 0, closedUnmergedAttempts: 1, mergedClosers: 0,
        assigned: false, claimRequired: false, issueOpen: true, substantivePriorAttempt: true
      }
    }),
    expected: { primary_mode: 'SALVAGE', acceptable_modes: ['REVIEW'], forbidden_modes: [] }
  },
  {
    id: 'recon-claim-required',
    name: 'Claim required → WATCH',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'VERIFY',
      disposition: 'claim_first',
      linked: { activeClosers: 0, activeRelatedPrs: 0, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: true }
    }),
    expected: { primary_mode: 'WATCH', acceptable_modes: [], forbidden_modes: ['BUILD'] }
  },
  {
    id: 'recon-assigned',
    name: 'Assigned → WATCH',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'VERIFY',
      disposition: 'greenfield',
      linked: { activeClosers: 0, activeRelatedPrs: 0, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: true, claimRequired: false }
    }),
    expected: { primary_mode: 'WATCH', acceptable_modes: [], forbidden_modes: ['BUILD'] }
  },
  {
    id: 'recon-released-fix',
    name: 'Released fix → PASS',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'SKIP',
      disposition: 'blocked',
      findings: [{ id: '1', type: 'released_fix', strength: 'definitive', effect: 'block', source: 'test', message: 'released', data: {} }],
      linked: { activeClosers: 0, activeRelatedPrs: 0, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false }
    }),
    expected: { primary_mode: 'PASS', acceptable_modes: [], forbidden_modes: ['BUILD'] }
  },
  {
    id: 'recon-no-pr-path',
    name: 'No PR path → PASS',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'SKIP',
      disposition: 'blocked',
      findings: [{ id: '1', type: 'no_pr_path', strength: 'definitive', effect: 'block', source: 'test', message: 'no pr', data: {} }],
      linked: { activeClosers: 0, activeRelatedPrs: 0, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false }
    }),
    expected: { primary_mode: 'PASS', acceptable_modes: [], forbidden_modes: ['BUILD'] }
  },
  {
    id: 'recon-docs-only',
    name: 'Docs-only → DOC',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'ACT',
      disposition: 'greenfield',
      categoryHints: { documentation: true, evaluation: false },
      linked: { activeClosers: 0, activeRelatedPrs: 0, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false }
    }),
    expected: { primary_mode: 'DOC', acceptable_modes: ['BUILD'], forbidden_modes: [] }
  },
  {
    id: 'recon-provider-failure',
    name: 'Provider failure → low-confidence non-BUILD',
    partition: 'reconstructed',
    facts: facts({
      verdict: 'VERIFY',
      disposition: 'greenfield',
      coverage: { ...complete, mandatory_checks_complete: false, failed_checks: ['linked_work'] },
      linked: { activeClosers: 0, activeRelatedPrs: 0, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false }
    }),
    expected: { primary_mode: 'WATCH', acceptable_modes: ['REVIEW', 'REPRODUCE', 'PASS'], forbidden_modes: ['BUILD'] }
  },
  {
    id: 'adv-closer-provider-error',
    name: 'Closer + provider error still forbids BUILD',
    partition: 'reconstructed',
    adversarial: true,
    facts: facts({
      verdict: 'VERIFY',
      disposition: 'land_only',
      findings: [{ id: '1', type: 'linked_pr_open', strength: 'definitive', effect: 'block', source: 'test', message: 'closer', data: {} }],
      coverage: { ...complete, mandatory_checks_complete: false, failed_checks: ['issue_vs_main'] },
      linked: { activeClosers: 1, activeRelatedPrs: 1, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false }
    }),
    expected: { primary_mode: 'REVIEW', acceptable_modes: ['WATCH'], forbidden_modes: ['BUILD'] }
  },
  {
    id: 'adv-title-overlap-only',
    name: 'Heuristic title overlap only cannot own the issue',
    partition: 'reconstructed',
    adversarial: true,
    facts: facts({
      verdict: 'VERIFY',
      disposition: 'crowded',
      findings: [{ id: '1', type: 'title_overlap_pr', strength: 'heuristic', effect: 'verify', source: 'test', message: 'overlap', data: {} }],
      linked: { activeClosers: 0, activeRelatedPrs: 1, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: false, claimRequired: false }
    }),
    expected: { primary_mode: 'REVIEW', acceptable_modes: ['WATCH', 'REPRODUCE'], forbidden_modes: [] }
  },
  {
    id: 'adv-assigned-plus-closer',
    name: 'Assigned + explicit closer still forbids BUILD',
    partition: 'reconstructed',
    adversarial: true,
    facts: facts({
      verdict: 'SKIP',
      disposition: 'land_only',
      findings: [{ id: '1', type: 'linked_pr_open', strength: 'definitive', effect: 'block', source: 'test', message: 'closer', data: {} }],
      linked: { activeClosers: 1, activeRelatedPrs: 1, closedUnmergedAttempts: 0, mergedClosers: 0, assigned: true, claimRequired: false }
    }),
    expected: { primary_mode: 'REVIEW', acceptable_modes: ['WATCH'], forbidden_modes: ['BUILD'] }
  }
];

export const reconstructedRoutingCases: RoutingEvalCase[] = reconstructedRoutingCaseDrafts.map((item) => ({
  adversarial: false,
  ...item
}));
