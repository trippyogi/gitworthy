/**
 * Bounded history scan (GW-050b). Runs only when the caller supplies paths, symbols, or terms.
 */

import { GitworthyError, createEnvelope, type Envelope } from './envelope.js';

export type HistoryHit = {
  sha: string;
  subject: string;
  paths: string[];
};

export type HistoryScanInput = {
  repo: string;
  paths?: string[];
  symbols?: string[];
  terms?: string[];
  limit?: number;
};

export type HistoryScanDeps = {
  log?: (input: { repo: string; paths: string[]; grep: string[]; limit: number }) => Promise<HistoryHit[]>;
};

const HISTORY_LIMIT = 20;

export async function history_scan(input: HistoryScanInput, deps: HistoryScanDeps = {}): Promise<Envelope & { hits: HistoryHit[] }> {
  const paths = input.paths ?? [];
  const symbols = input.symbols ?? [];
  const terms = input.terms ?? [];
  if (paths.length === 0 && symbols.length === 0 && terms.length === 0) {
    throw new GitworthyError({
      code: 'history_scan_requires_query',
      message: 'history_scan requires at least one path, symbol, or term.',
      not_checked: ['History scan is not automatic for every issue.']
    });
  }
  const limit = Math.min(input.limit ?? HISTORY_LIMIT, HISTORY_LIMIT);
  const hits = deps.log
    ? await deps.log({ repo: input.repo, paths, grep: [...symbols, ...terms], limit })
    : [];
  return {
    ...createEnvelope({
      verdict_summary: hits.length === 0
        ? 'history scan found no matching commits in the bounded window.'
        : `history scan found ${hits.length} bounded commit hits.`,
      evidence: hits.map((hit) => ({ kind: 'history_hit', sha: hit.sha, subject: hit.subject })),
      checked: [`bounded git history to ${limit} commits for supplied query`],
      not_checked: [
        'History scan does not run unless the caller supplies paths, symbols, or terms.',
        deps.log ? 'Used the injected log helper.' : 'No git log helper was supplied; returned an empty hit list.'
      ]
    }),
    hits
  };
}
