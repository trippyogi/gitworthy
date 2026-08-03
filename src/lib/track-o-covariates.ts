/**
 * Track O covariate storage — isolated from the verdict path.
 *
 * Import rule: `src/core/worth-check.ts`, hunt, linked_work, contention, and other
 * scoring modules must NEVER import this file. Only store persistence / Track O
 * reporting / CLI outcome tooling may touch covariates.
 */

import path from 'node:path';
import {
  TrackOCovariatesRecordSchema,
  type TrackOCovariatesFields,
  type TrackOCovariatesRecord
} from '../contracts/track-o.js';
import { readJsonFile, storeRoot, withStoreLock, writeJsonAtomic } from './store-fs.js';

function covariatesDir(): string {
  return path.join(storeRoot(), 'track-o', 'covariates');
}

function covariatesPath(decisionId: string): string {
  return path.join(covariatesDir(), `${decisionId}.json`);
}

export async function putTrackOCovariates(input: {
  decision_id: string;
  run_id: string;
  target: { repo: string; issue_number: number };
  captured_at?: string;
  reconstructed?: boolean;
  covariates?: TrackOCovariatesFields;
}): Promise<TrackOCovariatesRecord> {
  const record = TrackOCovariatesRecordSchema.parse({
    record_version: 1,
    record_kind: 'track_o_covariates',
    decision_id: input.decision_id,
    run_id: input.run_id,
    target: {
      repo: input.target.repo.toLowerCase(),
      issue_number: input.target.issue_number
    },
    captured_at: input.captured_at ?? new Date().toISOString(),
    reconstructed: input.reconstructed ?? false,
    covariates: input.covariates ?? {},
    knowable_at_t0: true
  });

  return withStoreLock(`track-o-covariates:${record.decision_id}`, async () => {
    await writeJsonAtomic(covariatesPath(record.decision_id), record);
    return record;
  });
}

export async function getTrackOCovariates(decisionId: string): Promise<TrackOCovariatesRecord | null> {
  const raw = await readJsonFile<unknown>(covariatesPath(decisionId));
  return raw ? TrackOCovariatesRecordSchema.parse(raw) : null;
}

/**
 * Best-effort covariates from a check result's already-known signals.
 * Does not call GitHub — avoids leaking post-T0 data and keeps checks fast.
 * Richer fields can be filled later by an explicit Track O enricher.
 */
export function covariatesFromCheckSignals(input: {
  signals?: string[];
  findings?: Array<{ type?: string }>;
}): TrackOCovariatesFields {
  const signals = input.signals ?? [];
  const linkedFromSignals = signals.filter((s) => s.startsWith('linked_pr')).length;
  const linkedFromFindings = (input.findings ?? []).filter((item) =>
    typeof item.type === 'string' && /linked|contention|closer/i.test(item.type)
  ).length;
  const linked = Math.max(linkedFromSignals, linkedFromFindings);
  return {
    linked_pr_count_at_check: linked > 0 ? linked : undefined
  };
}
