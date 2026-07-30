import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  forgetLedgerEntry,
  getLedgerEntry,
  ledgerPath,
  listLedgerEntries,
  readLedger,
  upsertLedgerEntry
} from '../src/lib/ledger.js';
import { ledger_list, ledger_lookup, ledger_record } from '../src/core/ledger.js';

let dir: string;

describe('ledger', () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-ledger-test-'));
    process.env.GITWORTHY_LEDGER_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.GITWORTHY_LEDGER_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('stores entries.json under the ledger dir', () => {
    expect(ledgerPath()).toBe(path.join(dir, 'entries.json'));
  });

  it('returns an empty ledger when no file exists yet', async () => {
    await expect(readLedger()).resolves.toEqual({});
    await expect(getLedgerEntry('o/r', 1)).resolves.toBeNull();
  });

  it('upserts a new entry, lowercasing the repo, and later updates it while preserving recorded_at', async () => {
    const created = await upsertLedgerEntry({ repo: 'Owner/Repo', issue_number: 42, verdict: 'ACT', disposition: 'greenfield', source: 'worth_check' });
    expect(created.repo).toBe('owner/repo');
    expect(created.issue_number).toBe(42);
    expect(created.recorded_at).toBe(created.updated_at);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await upsertLedgerEntry({ repo: 'owner/repo', issue_number: 42, verdict: 'SKIP', notes: 'shipped already' });
    expect(updated.recorded_at).toBe(created.recorded_at);
    expect(updated.updated_at).not.toBe(created.updated_at);
    expect(updated.verdict).toBe('SKIP');
    expect(updated.disposition).toBe('greenfield');
    expect(updated.notes).toBe('shipped already');

    const fetched = await getLedgerEntry('OWNER/REPO', 42);
    expect(fetched).toMatchObject({ repo: 'owner/repo', issue_number: 42, verdict: 'SKIP' });
  });

  it('lists entries filtered by repo, sorted by updated_at descending, and honors limit', async () => {
    await upsertLedgerEntry({ repo: 'o/r', issue_number: 1, verdict: 'ACT' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertLedgerEntry({ repo: 'o/r', issue_number: 2, verdict: 'SKIP' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertLedgerEntry({ repo: 'other/repo', issue_number: 3, verdict: 'VERIFY' });

    const all = await listLedgerEntries();
    expect(all.map((entry) => entry.issue_number)).toEqual([3, 2, 1]);

    const scoped = await listLedgerEntries({ repo: 'O/R' });
    expect(scoped.map((entry) => entry.issue_number)).toEqual([2, 1]);

    const limited = await listLedgerEntries({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].issue_number).toBe(3);
  });

  it('forgets an entry and reports whether one existed', async () => {
    await upsertLedgerEntry({ repo: 'o/r', issue_number: 7 });
    await expect(forgetLedgerEntry('o/r', 7)).resolves.toBe(true);
    await expect(getLedgerEntry('o/r', 7)).resolves.toBeNull();
    await expect(forgetLedgerEntry('o/r', 7)).resolves.toBe(false);
  });

  it('caps the store at ~2000 entries, dropping the oldest by updated_at', async () => {
    const capacity = 2000;
    const seeded: Record<string, unknown> = {};
    for (let i = 0; i < capacity; i++) {
      const updated_at = new Date(2026, 0, 1, 0, 0, i).toISOString();
      seeded[`o/r#${i}`] = { repo: 'o/r', issue_number: i, verdict: 'ACT', recorded_at: updated_at, updated_at };
    }
    await mkdir(path.dirname(ledgerPath()), { recursive: true });
    await writeFile(ledgerPath(), JSON.stringify(seeded, null, 2));

    await upsertLedgerEntry({ repo: 'o/r', issue_number: capacity, verdict: 'ACT' });

    const entries = await readLedger();
    expect(Object.keys(entries)).toHaveLength(capacity);
    expect(entries['o/r#0']).toBeUndefined();
    expect(entries[`o/r#${capacity}`]).toBeDefined();
    expect(entries['o/r#1']).toBeDefined();
  });

  it('serializes concurrent upserts so both entries survive', async () => {
    await Promise.all([
      upsertLedgerEntry({ repo: 'o/r', issue_number: 1, verdict: 'ACT' }),
      upsertLedgerEntry({ repo: 'o/r', issue_number: 2, verdict: 'SKIP' }),
      upsertLedgerEntry({ repo: 'o/r', issue_number: 3, verdict: 'VERIFY' })
    ]);
    const entries = await readLedger();
    expect(Object.keys(entries).sort()).toEqual(['o/r#1', 'o/r#2', 'o/r#3']);
  });
});

describe('core ledger wrappers', () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-ledger-core-test-'));
    process.env.GITWORTHY_LEDGER_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.GITWORTHY_LEDGER_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('ledger_lookup returns an empty envelope when nothing is recorded', async () => {
    const envelope = await ledger_lookup({ repo: 'o/r', issue_number: 9 });
    expect(envelope.evidence).toEqual([]);
    expect(envelope.verdict_summary).toContain('no prior ledger entry');
  });

  it('ledger_record upserts and ledger_lookup finds it afterward', async () => {
    const recorded = await ledger_record({ repo: 'o/r', issue_number: 9, verdict: 'ACT', disposition: 'greenfield', quality_score: 0.8, source: 'manual' });
    expect(recorded.evidence).toHaveLength(1);
    expect(recorded.evidence[0]).toMatchObject({ repo: 'o/r', issue_number: 9, verdict: 'ACT', quality_score: 0.8 });

    const lookedUp = await ledger_lookup({ repo: 'o/r', issue_number: 9 });
    expect(lookedUp.evidence).toHaveLength(1);
    expect(lookedUp.evidence[0]).toMatchObject({ verdict: 'ACT', disposition: 'greenfield' });
  });

  it('ledger_list reports the count and entries', async () => {
    await ledger_record({ repo: 'o/r', issue_number: 1, verdict: 'ACT' });
    await ledger_record({ repo: 'o/r', issue_number: 2, verdict: 'SKIP' });
    const listed = await ledger_list({ repo: 'o/r' });
    expect(listed.evidence).toHaveLength(2);
    expect(listed.verdict_summary).toContain('found 2 ledger entries');
  });
});
