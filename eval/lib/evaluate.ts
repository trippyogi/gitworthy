import type { EvalCase, EvalRowStatus } from '../../src/contracts/eval.js';
import { includes, positiveWorldChange } from './shared.js';

export type EvalRow = {
  id: string;
  name: string;
  status: EvalRowStatus;
  detail: string;
  failure_mode?: string;
};

export function classifyThrownError(message: string): EvalRowStatus {
  if (/GITHUB_TOKEN|required for this GitHub API check|missing_github_token/i.test(message)) return 'auth_limitation';
  if (/rate limit|secondary\s+rate\s+limit|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(message)) {
    return 'provider_failure';
  }
  if (/blocked|rate limit/i.test(message)) return 'blocked';
  return 'failed';
}

/** Live-suite evaluation: soft expectations + drift vs snapshot. */
export function evaluateLive(result: Record<string, unknown>, spec: EvalCase, previous: Record<string, unknown> | null): EvalRow {
  const expect = spec.expect ?? {};
  const failures: string[] = [];
  if (typeof expect.signal === 'string' && !(result.signals as string[] | undefined)?.includes(expect.signal)) {
    failures.push(`missing signal ${expect.signal}`);
  }
  if (typeof expect.no_signal === 'string' && (result.signals as string[] | undefined)?.includes(expect.no_signal)) {
    failures.push(`unexpected signal ${expect.no_signal}`);
  }
  if (typeof expect.verdict === 'string' && result.verdict !== expect.verdict) {
    failures.push(`expected verdict ${expect.verdict}, observed ${String(result.verdict)}`);
  }
  if (typeof expect.summary_contains === 'string' && !String(result.verdict_summary).toLowerCase().includes(expect.summary_contains.toLowerCase())) {
    failures.push(`summary missing ${expect.summary_contains}`);
  }
  if (typeof expect.evidence_contains === 'string' && !includes(result, expect.evidence_contains)) {
    failures.push(`evidence missing ${expect.evidence_contains}`);
  }
  if (Array.isArray(expect.evidence_contains_all)) {
    for (const needle of expect.evidence_contains_all) {
      if (!includes(result, needle)) failures.push(`evidence missing ${needle}`);
    }
  }
  if (!Array.isArray(result.checked) || result.checked.length === 0) failures.push('checked is empty');
  if (!Array.isArray(result.not_checked) || result.not_checked.length === 0) failures.push('not_checked is empty');

  if (failures.length === 0) {
    return { id: spec.id, name: spec.name, status: 'passed', detail: 'mechanism matched expected signal' };
  }
  if (spec.time_sensitive === true && positiveWorldChange(result, previous, spec)) {
    return { id: spec.id, name: spec.name, status: 'drifted', detail: failures.join('; ') };
  }
  return {
    id: spec.id,
    name: spec.name,
    status: 'product_regression',
    detail: failures.join('; ')
  };
}

/** Frozen-suite evaluation against adjudicated ground truth. */
export function evaluateFrozen(result: Record<string, unknown>, spec: EvalCase): EvalRow {
  const truth = spec.ground_truth;
  if (!truth) {
    return { id: spec.id, name: spec.name, status: 'failed', detail: 'frozen case missing ground_truth' };
  }
  const failures: string[] = [];
  if ('verdict' in result && result.verdict !== undefined && result.verdict !== truth.verdict) {
    failures.push(`expected verdict ${truth.verdict}, observed ${String(result.verdict)}`);
  } else if (spec.function === 'worth_check' && result.verdict !== truth.verdict) {
    failures.push(`expected verdict ${truth.verdict}, observed ${String(result.verdict)}`);
  }
  for (const signal of truth.required_signals) {
    if (!(result.signals as string[] | undefined)?.includes(signal)) failures.push(`missing required signal ${signal}`);
  }
  for (const signal of truth.forbidden_signals) {
    if ((result.signals as string[] | undefined)?.includes(signal)) failures.push(`forbidden signal ${signal}`);
  }
  for (const needle of truth.required_findings) {
    if (!includes(result, needle)) failures.push(`missing required finding ${needle}`);
  }
  for (const needle of truth.forbidden_findings) {
    if (includes(result, needle)) failures.push(`forbidden finding ${needle}`);
  }
  if (!Array.isArray(result.checked) || result.checked.length === 0) failures.push('checked is empty');
  if (!Array.isArray(result.not_checked) || result.not_checked.length === 0) failures.push('not_checked is empty');

  if (failures.length === 0) {
    return {
      id: spec.id,
      name: spec.name,
      status: 'passed',
      detail: `ground truth matched (${truth.failure_mode})`,
      failure_mode: truth.failure_mode
    };
  }
  return {
    id: spec.id,
    name: spec.name,
    status: 'failed',
    detail: failures.join('; '),
    failure_mode: truth.failure_mode
  };
}
