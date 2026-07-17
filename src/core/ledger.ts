import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { GitworthyError } from './envelope.js';

export type LedgerStatus = 'candidate' | 'claimed' | 'reproved' | 'patched' | 'pr_or_comment' | 'done' | 'abandoned';
export type LedgerVerdict = 'ACT' | 'VERIFY' | 'SKIP';

export type LedgerRecord = {
  repo: string;
  issue_number: number;
  url: string;
  verdict?: LedgerVerdict;
  signals?: string[];
  status: LedgerStatus;
  claimed_at?: string;
  chat_id?: string;
  notes?: string;
  updated_at: string;
};

type LedgerFile = { records: LedgerRecord[] };

const ACTIVE_CLAIM_STATUSES: LedgerStatus[] = ['claimed', 'reproved', 'patched', 'pr_or_comment'];

function ledgerPath(): string {
  return process.env.GITWORTHY_LEDGER_PATH ?? join(homedir(), '.gitworthy', 'ledger.json');
}

function nowIso(): string {
  return new Date().toISOString();
}

function issueUrl(repo: string, issue_number: number): string {
  return `https://github.com/${repo}/issues/${issue_number}`;
}

export function parseIssueRef(ref: string): { repo: string; issue_number: number } {
  const match = ref.match(/^([^#]+)#(\d+)$/);
  if (!match) {
    throw new GitworthyError({ code: 'invalid_issue_ref', message: 'Expected issue ref like owner/repo#123.' });
  }
  return { repo: match[1], issue_number: Number(match[2]) };
}

async function readLedger(): Promise<LedgerFile> {
  try {
    const raw = await readFile(ledgerPath(), 'utf8');
    return JSON.parse(raw) as LedgerFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [] };
    throw error;
  }
}

async function writeLedger(data: LedgerFile): Promise<void> {
  const path = ledgerPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function findRecord(records: LedgerRecord[], repo: string, issue_number: number): LedgerRecord | undefined {
  return records.find((record) => record.repo === repo && record.issue_number === issue_number);
}

function hasActiveClaim(record: LedgerRecord): boolean {
  return ACTIVE_CLAIM_STATUSES.includes(record.status);
}

type AddInput = {
  repo: string;
  issue_number: number;
  verdict?: LedgerVerdict;
  status?: LedgerStatus;
  signals?: string[];
  url?: string;
};

export async function ledger_add(input: AddInput): Promise<LedgerRecord> {
  const ledger = await readLedger();
  const existing = findRecord(ledger.records, input.repo, input.issue_number);
  const now = nowIso();
  const status = input.status ?? 'candidate';

  if (existing) {
    if (input.verdict !== undefined) existing.verdict = input.verdict;
    if (input.signals !== undefined) existing.signals = input.signals;
    existing.status = status;
    if (input.url) existing.url = input.url;
    existing.updated_at = now;
    await writeLedger(ledger);
    return existing;
  }

  const record: LedgerRecord = {
    repo: input.repo,
    issue_number: input.issue_number,
    url: input.url ?? issueUrl(input.repo, input.issue_number),
    verdict: input.verdict,
    signals: input.signals,
    status,
    updated_at: now
  };
  ledger.records.push(record);
  await writeLedger(ledger);
  return record;
}

type ListInput = { status?: LedgerStatus; repo?: string };

export async function ledger_list(input: ListInput = {}): Promise<{ records: LedgerRecord[] }> {
  const ledger = await readLedger();
  let records = ledger.records;
  if (input.repo) records = records.filter((record) => record.repo === input.repo);
  if (input.status) records = records.filter((record) => record.status === input.status);
  return { records };
}

type ClaimInput = { repo: string; issue_number: number; chat_id?: string };

export async function ledger_claim(input: ClaimInput): Promise<LedgerRecord> {
  const ledger = await readLedger();
  const existing = findRecord(ledger.records, input.repo, input.issue_number);

  if (existing && hasActiveClaim(existing)) {
    throw new GitworthyError({
      code: 'ledger_claim_conflict',
      message: `Issue ${input.repo}#${input.issue_number} already has status ${existing.status}.`,
      checked: [`ledger entry for ${existing.url}`],
      not_checked: []
    });
  }

  const now = nowIso();
  if (existing) {
    existing.status = 'claimed';
    existing.claimed_at = now;
    existing.updated_at = now;
    if (input.chat_id !== undefined) existing.chat_id = input.chat_id;
    await writeLedger(ledger);
    return existing;
  }

  const record: LedgerRecord = {
    repo: input.repo,
    issue_number: input.issue_number,
    url: issueUrl(input.repo, input.issue_number),
    status: 'claimed',
    claimed_at: now,
    chat_id: input.chat_id,
    updated_at: now
  };
  ledger.records.push(record);
  await writeLedger(ledger);
  return record;
}

type UpdateInput = { repo: string; issue_number: number; status: LedgerStatus; notes?: string };

export async function ledger_update(input: UpdateInput): Promise<LedgerRecord> {
  const ledger = await readLedger();
  const existing = findRecord(ledger.records, input.repo, input.issue_number);

  if (!existing) {
    throw new GitworthyError({
      code: 'ledger_not_found',
      message: `No ledger entry for ${input.repo}#${input.issue_number}.`,
      checked: [],
      not_checked: [`ledger has no record for ${input.repo}#${input.issue_number}`]
    });
  }

  existing.status = input.status;
  existing.updated_at = nowIso();
  if (input.notes !== undefined) existing.notes = input.notes;
  await writeLedger(ledger);
  return existing;
}
