import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
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

function lockPath(): string {
  return `${ledgerPath()}.lock`;
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

async function withLedgerLock<T>(run: () => Promise<T>): Promise<T> {
  const path = lockPath();
  await mkdir(dirname(path), { recursive: true });
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const started = Date.now();
  while (!handle) {
    try {
      handle = await open(path, 'wx');
      await handle.writeFile(token, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > 30_000) {
          await unlink(path).catch(() => undefined);
        }
      } catch {
        // lock may have been removed between checks
      }
      if (Date.now() - started > 5000) {
        throw new GitworthyError({ code: 'ledger_lock_timeout', message: `Timed out waiting for ledger lock at ${path}.` });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await run();
  } finally {
    try {
      const current = await readFile(path, 'utf8');
      if (current === token) await unlink(path).catch(() => undefined);
    } catch {
      // lock already gone or unreadable
    }
    await handle.close().catch(() => undefined);
  }
}

async function readLedger(): Promise<LedgerFile> {
  try {
    const raw = await readFile(ledgerPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LedgerFile> | null;
    if (!parsed || !Array.isArray(parsed.records)) {
      throw new GitworthyError({
        code: 'ledger_corrupt',
        message: `Ledger file at ${ledgerPath()} is missing a records array.`,
        checked: [`read ${ledgerPath()}`],
        not_checked: []
      });
    }
    return { records: parsed.records };
  } catch (error) {
    if (error instanceof GitworthyError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [] };
    if (error instanceof SyntaxError) {
      throw new GitworthyError({
        code: 'ledger_corrupt',
        message: `Ledger file at ${ledgerPath()} is not valid JSON.`,
        checked: [`read ${ledgerPath()}`],
        not_checked: []
      });
    }
    throw error;
  }
}

async function writeLedger(data: LedgerFile): Promise<void> {
  const path = ledgerPath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temp, path);
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

function applyClaimedAt(record: LedgerRecord, status: LedgerStatus, now: string): void {
  if (status === 'claimed') record.claimed_at = now;
}

export async function ledger_add(input: AddInput): Promise<LedgerRecord> {
  return withLedgerLock(async () => {
    const ledger = await readLedger();
    const existing = findRecord(ledger.records, input.repo, input.issue_number);
    const now = nowIso();

    if (existing) {
      if (hasActiveClaim(existing) && input.status !== undefined && input.status !== existing.status) {
        throw new GitworthyError({
          code: 'ledger_claim_conflict',
          message: `Issue ${input.repo}#${input.issue_number} already has status ${existing.status}; use ledger update or abandon before changing status via add.`,
          checked: [`ledger entry for ${existing.url}`],
          not_checked: []
        });
      }
      if (input.verdict !== undefined) existing.verdict = input.verdict;
      if (input.signals !== undefined) existing.signals = input.signals;
      if (input.status !== undefined) {
        existing.status = input.status;
        applyClaimedAt(existing, input.status, now);
      }
      if (input.url) existing.url = input.url;
      existing.updated_at = now;
      await writeLedger(ledger);
      return existing;
    }

    const status = input.status ?? 'candidate';
    const record: LedgerRecord = {
      repo: input.repo,
      issue_number: input.issue_number,
      url: input.url ?? issueUrl(input.repo, input.issue_number),
      verdict: input.verdict,
      signals: input.signals,
      status,
      updated_at: now
    };
    applyClaimedAt(record, status, now);
    ledger.records.push(record);
    await writeLedger(ledger);
    return record;
  });
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
  return withLedgerLock(async () => {
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
      existing.chat_id = input.chat_id;
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
  });
}

type UpdateInput = { repo: string; issue_number: number; status: LedgerStatus; notes?: string };

export async function ledger_update(input: UpdateInput): Promise<LedgerRecord> {
  return withLedgerLock(async () => {
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

    const now = nowIso();
    existing.status = input.status;
    applyClaimedAt(existing, input.status, now);
    existing.updated_at = now;
    if (input.notes !== undefined) existing.notes = input.notes;
    await writeLedger(ledger);
    return existing;
  });
}
