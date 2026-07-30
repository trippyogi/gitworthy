import { getLedgerEntry, listLedgerEntries, upsertLedgerEntry } from '../lib/ledger.js';
import { createEnvelope, Envelope } from './envelope.js';

const LEDGER_CAVEAT = 'ledger entries are local and best-effort; they reflect prior runs on this machine, not a live check of current upstream state.';

export async function ledger_lookup(input: { repo: string; issue_number: number }): Promise<Envelope> {
  const entry = await getLedgerEntry(input.repo, input.issue_number);
  return createEnvelope({
    verdict_summary: entry
      ? `found a prior ledger entry for ${input.repo}#${input.issue_number}, last updated ${entry.updated_at}.`
      : `no prior ledger entry found for ${input.repo}#${input.issue_number}.`,
    evidence: entry ? [{ ...entry }] : [],
    checked: [`looked up ledger entry for ${input.repo}#${input.issue_number}`],
    not_checked: [LEDGER_CAVEAT]
  });
}

export async function ledger_record(input: {
  repo: string;
  issue_number: number;
  verdict?: string;
  disposition?: string;
  quality_score?: number;
  notes?: string;
  source?: string;
}): Promise<Envelope> {
  const entry = await upsertLedgerEntry(input);
  return createEnvelope({
    verdict_summary: `recorded ledger entry for ${input.repo}#${input.issue_number}.`,
    evidence: [{ ...entry }],
    checked: [`upserted ledger entry for ${input.repo}#${input.issue_number}`],
    not_checked: [LEDGER_CAVEAT]
  });
}

export async function ledger_list(input: { repo?: string; limit?: number } = {}): Promise<Envelope> {
  const entries = await listLedgerEntries(input);
  return createEnvelope({
    verdict_summary: `found ${entries.length} ledger ${entries.length === 1 ? 'entry' : 'entries'}${input.repo ? ` for ${input.repo}` : ''}.`,
    evidence: entries.map((entry) => ({ ...entry })),
    checked: [input.repo ? `listed ledger entries for ${input.repo}` : 'listed all ledger entries'],
    not_checked: [LEDGER_CAVEAT]
  });
}
