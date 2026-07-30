import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type LedgerEntry = {
  repo: string;
  issue_number: number;
  verdict?: string;
  disposition?: string;
  quality_score?: number;
  notes?: string;
  source?: string;
  recorded_at: string;
  updated_at: string;
};

export type LedgerUpsertInput = {
  repo: string;
  issue_number: number;
  verdict?: string;
  disposition?: string;
  quality_score?: number;
  notes?: string;
  source?: string;
};

const LEDGER_FILE = 'entries.json';
const MAX_ENTRIES = 2000;

export function ledgerRoot(): string {
  return process.env.GITWORTHY_LEDGER_DIR || path.join(homedir(), '.gitworthy', 'ledger');
}

export function ledgerPath(): string {
  return path.join(ledgerRoot(), LEDGER_FILE);
}

function ledgerKey(repo: string, issue_number: number): string {
  return `${repo.toLowerCase()}#${issue_number}`;
}

export async function readLedger(): Promise<Record<string, LedgerEntry>> {
  try {
    const raw = await readFile(ledgerPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, LedgerEntry>) : {};
  } catch {
    return {};
  }
}

async function writeLedger(entries: Record<string, LedgerEntry>): Promise<void> {
  const file = ledgerPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(entries, null, 2));
  await rename(tmp, file);
}

function pruneToCapacity(entries: Record<string, LedgerEntry>): Record<string, LedgerEntry> {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_ENTRIES) return entries;
  const oldestFirst = [...keys].sort((a, b) => entries[a].updated_at.localeCompare(entries[b].updated_at));
  const dropped = new Set(oldestFirst.slice(0, keys.length - MAX_ENTRIES));
  const kept: Record<string, LedgerEntry> = {};
  for (const key of keys) {
    if (!dropped.has(key)) kept[key] = entries[key];
  }
  return kept;
}

/** Serialize ledger mutations in-process so concurrent worth_check records cannot clobber each other. */
let ledgerWriteChain: Promise<unknown> = Promise.resolve();

function withLedgerLock<T>(run: () => Promise<T>): Promise<T> {
  const next = ledgerWriteChain.then(run, run);
  ledgerWriteChain = next.then(() => undefined, () => undefined);
  return next;
}

export async function upsertLedgerEntry(input: LedgerUpsertInput): Promise<LedgerEntry> {
  return withLedgerLock(async () => {
    const entries = await readLedger();
    const key = ledgerKey(input.repo, input.issue_number);
    const now = new Date().toISOString();
    const existing = entries[key];
    const entry: LedgerEntry = {
      repo: input.repo.toLowerCase(),
      issue_number: input.issue_number,
      verdict: input.verdict ?? existing?.verdict,
      disposition: input.disposition ?? existing?.disposition,
      quality_score: input.quality_score ?? existing?.quality_score,
      notes: input.notes ?? existing?.notes,
      source: input.source ?? existing?.source,
      recorded_at: existing?.recorded_at ?? now,
      updated_at: now
    };
    entries[key] = entry;
    await writeLedger(pruneToCapacity(entries));
    return entry;
  });
}

export async function getLedgerEntry(repo: string, issue_number: number): Promise<LedgerEntry | null> {
  const entries = await readLedger();
  return entries[ledgerKey(repo, issue_number)] ?? null;
}

export async function listLedgerEntries(input: { repo?: string; limit?: number } = {}): Promise<LedgerEntry[]> {
  const entries = await readLedger();
  let list = Object.values(entries);
  if (input.repo) {
    const repoLower = input.repo.toLowerCase();
    list = list.filter((entry) => entry.repo === repoLower);
  }
  list = list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (typeof input.limit === 'number') list = list.slice(0, Math.max(0, input.limit));
  return list;
}

export async function forgetLedgerEntry(repo: string, issue_number: number): Promise<boolean> {
  return withLedgerLock(async () => {
    const entries = await readLedger();
    const key = ledgerKey(repo, issue_number);
    if (!(key in entries)) return false;
    delete entries[key];
    await writeLedger(entries);
    return true;
  });
}
