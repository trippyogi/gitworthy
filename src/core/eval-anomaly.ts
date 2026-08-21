/**
 * Eval-anomaly opportunity ingest (GW-050d).
 */

import { OpportunityTargetSchema, type OpportunityTarget } from '../contracts/opportunities.js';
import { GitworthyError, createEnvelope, type Envelope } from './envelope.js';

export type EvalAnomalyInput = {
  external_id: string;
  source: string;
  repo?: string;
  title?: string;
  detail?: string;
};

export type EvalAnomalyResult = Envelope & {
  target: OpportunityTarget;
};

export function ingest_eval_anomaly(input: EvalAnomalyInput): EvalAnomalyResult {
  if (!input.external_id.trim() || !input.source.trim()) {
    throw new GitworthyError({
      code: 'eval_anomaly_invalid_input',
      message: 'eval_anomaly requires external_id and source.',
      not_checked: ['Eval anomaly ingest does not invent identifiers.']
    });
  }
  const target = OpportunityTargetSchema.parse({
    kind: 'eval_anomaly',
    external_id: input.external_id,
    source: input.source,
    ...(input.repo ? { repo: input.repo } : {})
  });
  return {
    ...createEnvelope({
      verdict_summary: `ingested eval anomaly ${input.source}:${input.external_id}.`,
      evidence: [{
        kind: 'eval_anomaly',
        external_id: input.external_id,
        source: input.source,
        title: input.title,
        detail: input.detail
      }],
      checked: ['accepted an externally supplied eval anomaly'],
      not_checked: ['GitWorthy does not scrape eval farms; the caller must supply the anomaly.']
    }),
    target
  };
}
