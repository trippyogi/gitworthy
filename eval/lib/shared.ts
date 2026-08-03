import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  branch_scan,
  contention,
  contrib_policy,
  dupe_cluster,
  issue_vs_main,
  linked_work,
  release_gap,
  worth_check
} from '../../src/core/index.js';
import type { EvalCase } from '../../src/contracts/eval.js';

export const evalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const runners = {
  branch_scan,
  issue_vs_main,
  release_gap,
  dupe_cluster,
  contrib_policy,
  linked_work,
  contention,
  worth_check
} as const;

export function textOf(value: unknown): string {
  return JSON.stringify(value).toLowerCase();
}

export function includes(value: unknown, needle: unknown): boolean {
  return textOf(value).includes(String(needle).toLowerCase());
}

export function fixtureJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/\u2014/g, '-');
}

export function branchNames(value: Record<string, unknown>): string[] {
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  return evidence
    .map((item) => (typeof item === 'object' && item !== null && 'branch' in item ? String((item as { branch: unknown }).branch) : ''))
    .filter(Boolean)
    .sort();
}

export function npmVersion(value: Record<string, unknown>): string | undefined {
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const packageEvidence = evidence.find((item) => typeof item === 'object' && item !== null && 'package' in item && 'version' in item) as
    | { version?: unknown }
    | undefined;
  return typeof packageEvidence?.version === 'string' ? packageEvidence.version : undefined;
}

export function positiveWorldChange(result: Record<string, unknown>, previous: Record<string, unknown> | null, spec: EvalCase): boolean {
  if (!previous) return false;
  if (spec.function === 'branch_scan') return JSON.stringify(branchNames(result)) !== JSON.stringify(branchNames(previous));
  if (spec.function === 'release_gap') return npmVersion(result) !== npmVersion(previous);
  if (spec.function === 'worth_check') return includes(result, 'branch_scan') && textOf(result) !== textOf(previous);
  return false;
}

export function resolveProviderFixturesPath(caseFilePath: string, relativePath: string): string {
  return path.resolve(path.dirname(caseFilePath), relativePath);
}
