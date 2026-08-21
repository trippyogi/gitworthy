/**
 * Honest CI classification (GW-050a).
 * Does not infer STALE_FIXTURE from metadata.
 */

import { createEnvelope, type Envelope } from './envelope.js';

export const CI_TRIAGE_CLASSES = [
  'head_only_failure',
  'base_failure',
  'shared_failure',
  'flaky_suspected',
  'unknown'
] as const;

export type CiTriageClass = (typeof CI_TRIAGE_CLASSES)[number];

export type CiCheck = {
  name: string;
  conclusion?: string | null;
  status?: string;
  attempt?: number;
};

export type CiTriageResult = {
  class: CiTriageClass;
  reasons: string[];
  failed_on_head: string[];
  failed_on_base: string[];
};

function failed(check: CiCheck): boolean {
  return check.conclusion === 'failure' || check.conclusion === 'timed_out';
}

function succeeded(check: CiCheck): boolean {
  return check.conclusion === 'success' || check.conclusion === 'skipped' || check.conclusion === 'neutral';
}

/** Classify head vs optional base checks. Never emits stale_fixture. */
export function classifyCi(input: { head: CiCheck[]; base?: CiCheck[] }): CiTriageResult {
  const headFails = [...new Set(input.head.filter(failed).map((check) => check.name))];
  const baseFails = [...new Set((input.base ?? []).filter(failed).map((check) => check.name))];
  const reasons: string[] = [];

  const byName = new Map<string, CiCheck[]>();
  for (const check of input.head) {
    const list = byName.get(check.name) ?? [];
    list.push(check);
    byName.set(check.name, list);
  }
  const flaky = [...byName.entries()].some(([, runs]) => runs.some(failed) && runs.some(succeeded));
  if (flaky) {
    reasons.push('Same check both failed and succeeded across attempts.');
    return { class: 'flaky_suspected', reasons, failed_on_head: headFails, failed_on_base: baseFails };
  }

  if (headFails.length === 0 && baseFails.length === 0) {
    reasons.push('No failed conclusions on head or base.');
    return { class: 'unknown', reasons, failed_on_head: headFails, failed_on_base: baseFails };
  }
  const baseSupplied = (input.base?.length ?? 0) > 0;
  if (!baseSupplied) {
    reasons.push('Base check runs were not supplied; cannot distinguish head-only from shared.');
    return { class: 'unknown', reasons, failed_on_head: headFails, failed_on_base: baseFails };
  }
  const shared = headFails.filter((name) => baseFails.includes(name));
  if (shared.length > 0 && shared.length === headFails.length) {
    reasons.push('Every head failure also failed on base.');
    return { class: 'shared_failure', reasons, failed_on_head: headFails, failed_on_base: baseFails };
  }
  if (shared.length > 0) {
    reasons.push('Head and base failures overlap only in part.');
    return { class: 'shared_failure', reasons, failed_on_head: headFails, failed_on_base: baseFails };
  }
  if (headFails.length > 0 && baseFails.length === 0) {
    reasons.push('Head failed while supplied base checks succeeded.');
    return { class: 'head_only_failure', reasons, failed_on_head: headFails, failed_on_base: baseFails };
  }
  if (headFails.length === 0 && baseFails.length > 0) {
    reasons.push('Base failed while head succeeded.');
    return { class: 'base_failure', reasons, failed_on_head: headFails, failed_on_base: baseFails };
  }
  reasons.push('Head and base failed disjoint checks; not treating that as a shared failure.');
  return { class: 'unknown', reasons, failed_on_head: headFails, failed_on_base: baseFails };
}

function nextActionFor(classified: CiTriageResult): string {
  switch (classified.class) {
    case 'head_only_failure':
      return 'Inspect the failing head check on this branch; do not treat it as a stale fixture.';
    case 'base_failure':
      return 'Base is already red; wait or fix the shared base before treating this as a head-only regression.';
    case 'shared_failure':
      return 'Failure is shared with base; do not treat it as unique to this change.';
    case 'flaky_suspected':
      return 'Same check passed and failed across attempts; rerun or quarantine before routing.';
    default:
      return 'Supply head and base check conclusions before using CI class as routing evidence.';
  }
}

/** Envelope wrapper for CLI/MCP. Never emits stale_fixture. */
export function ci_triage(input: { head: CiCheck[]; base?: CiCheck[] }): Envelope & CiTriageResult & {
  confidence: 'low' | 'medium';
  next_actions: Array<{ action: string; command?: string; message: string }>;
} {
  const classified = classifyCi(input);
  const next = nextActionFor(classified);
  return {
    ...createEnvelope({
      verdict_summary: `CI triage class ${classified.class}.`,
      evidence: [{
        kind: 'ci_triage',
        class: classified.class,
        reasons: classified.reasons,
        failed_on_head: classified.failed_on_head,
        failed_on_base: classified.failed_on_base
      }],
      checked: ['classified supplied head/base check conclusions'],
      not_checked: [
        'CI triage never infers stale_fixture from metadata.',
        (input.base?.length ?? 0) === 0 ? 'Base check runs were not supplied.' : 'Used caller-supplied base conclusions only.'
      ]
    }),
    ...classified,
    confidence: classified.class === 'unknown' ? 'low' : 'medium',
    next_actions: [{ action: 'inspect_ci', message: next }]
  };
}
