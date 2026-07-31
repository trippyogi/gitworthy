import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DispositionSchema, VerdictSchema, newDecisionId, newRunId } from '../contracts/common.js';
import { ledgerPath, ledgerRoot, type LedgerEntry } from './ledger.js';
import { putDecisionRecord, putRunRecord, rebuildTargetIndexes } from './store.js';
import { readJsonFile, storeRoot, withStoreLock, writeJsonAtomic } from './store-fs.js';

type Verdict = z.infer<typeof VerdictSchema>;
type Disposition = z.infer<typeof DispositionSchema>;

const MIGRATION_ID = 'legacy-ledger-v1';

export type LedgerMigrationReport = {
  migration_id: string;
  already_done: boolean;
  migrated: number;
  quarantined: number;
  skipped: number;
  rebuilt_targets: number;
  quarantine_dir: string;
  marker_path: string;
  ledger_path: string;
};

type MigrationMarker = {
  migration_id: string;
  completed_at: string;
  migrated: number;
  quarantined: number;
};

function migrationMarkerPath(): string {
  return path.join(storeRoot(), 'migrations', `${MIGRATION_ID}.json`);
}

function quarantineRoot(): string {
  return path.join(ledgerRoot(), 'quarantine');
}

function asVerdict(value: unknown): Verdict | null {
  const parsed = VerdictSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asDisposition(value: unknown): Disposition {
  const parsed = DispositionSchema.safeParse(value);
  return parsed.success ? parsed.data : 'review';
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.repo === 'string'
    && row.repo.includes('/')
    && typeof row.issue_number === 'number'
    && Number.isInteger(row.issue_number)
    && row.issue_number > 0
    && typeof row.recorded_at === 'string'
    && typeof row.updated_at === 'string';
}

async function quarantineBlob(name: string, contents: string): Promise<string> {
  const dir = quarantineRoot();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, contents, 'utf8');
  return file;
}

async function readLegacyLedgerRaw(): Promise<{ entries: Record<string, unknown>; quarantinedFile: string | null }> {
  const file = ledgerPath();
  try {
    const raw = await readFile(file, 'utf8');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const quarantined = await quarantineBlob(`entries.invalid-shape.${Date.now()}.json`, raw);
        return { entries: {}, quarantinedFile: quarantined };
      }
      return { entries: parsed as Record<string, unknown>, quarantinedFile: null };
    } catch {
      const quarantined = await quarantineBlob(`entries.invalid-json.${Date.now()}.json`, raw);
      // Move aside the broken ledger so future reads start clean.
      await rename(file, `${file}.broken.${Date.now()}`).catch(async () => {
        await rm(file, { force: true }).catch(() => undefined);
      });
      return { entries: {}, quarantinedFile: quarantined };
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'ENOENT') return { entries: {}, quarantinedFile: null };
    throw error;
  }
}

async function migrateOneEntry(entry: LedgerEntry): Promise<void> {
  const runId = newRunId();
  const decisionId = newDecisionId();
  const verdict = asVerdict(entry.verdict) ?? 'VERIFY';
  const disposition = asDisposition(entry.disposition);
  const createdAt = entry.updated_at || entry.recorded_at || new Date().toISOString();
  const repo = entry.repo.toLowerCase();
  const reasons = [
    `migrated from legacy ledger (${entry.source ?? 'unknown source'})`,
    ...(entry.notes ? [entry.notes] : [])
  ];

  await putDecisionRecord({
    decision_id: decisionId,
    run_id: runId,
    created_at: createdAt,
    target: {
      input_repo: repo,
      canonical_repo: repo,
      issue_number: entry.issue_number,
      issue_url: `https://github.com/${repo}/issues/${entry.issue_number}`
    },
    verdict,
    disposition,
    next_actions: [],
    findings: [],
    reasons,
    signals: []
  });
  await putRunRecord({
    run_id: runId,
    command: 'ledger_migrate',
    generated_at: createdAt,
    cached: false,
    summary: `Migrated legacy ledger entry for ${repo}#${entry.issue_number}.`,
    target: { repo, issue_number: entry.issue_number },
    decision_id: decisionId,
    checked: ['legacy ledger entry'],
    not_checked: ['full check pipeline was not re-run during ledger migration'],
    metrics: {
      ...(typeof entry.quality_score === 'number' ? { quality_score: entry.quality_score } : {})
    }
  });
}

/** Migrate ~/.gitworthy/ledger into versioned store records; quarantine corrupt rows. */
export async function migrateLegacyLedger(opts: { force?: boolean } = {}): Promise<LedgerMigrationReport> {
  const markerPath = migrationMarkerPath();
  const quarantineDir = quarantineRoot();

  return withStoreLock('migrate-legacy-ledger', async () => {
    const existing = await readJsonFile<MigrationMarker>(markerPath);
    if (existing && !opts.force) {
      return {
        migration_id: MIGRATION_ID,
        already_done: true,
        migrated: existing.migrated,
        quarantined: existing.quarantined,
        skipped: 0,
        rebuilt_targets: 0,
        quarantine_dir: quarantineDir,
        marker_path: markerPath,
        ledger_path: ledgerPath()
      };
    }

    const { entries, quarantinedFile } = await readLegacyLedgerRaw();
    let migrated = 0;
    let quarantined = quarantinedFile ? 1 : 0;
    const skipped = 0;

    for (const [key, value] of Object.entries(entries)) {
      if (!isLedgerEntry(value)) {
        await quarantineBlob(`entry.${key.replace(/[^a-zA-Z0-9._#-]+/g, '_')}.${Date.now()}.json`, `${JSON.stringify({ key, value }, null, 2)}\n`);
        quarantined += 1;
        continue;
      }
      try {
        await migrateOneEntry(value);
        migrated += 1;
      } catch {
        await quarantineBlob(
          `entry-failed.${key.replace(/[^a-zA-Z0-9._#-]+/g, '_')}.${Date.now()}.json`,
          `${JSON.stringify({ key, value }, null, 2)}\n`
        );
        quarantined += 1;
      }
    }

    const rebuilt = await rebuildTargetIndexes();
    const marker: MigrationMarker = {
      migration_id: MIGRATION_ID,
      completed_at: new Date().toISOString(),
      migrated,
      quarantined
    };
    await writeJsonAtomic(markerPath, marker);

    return {
      migration_id: MIGRATION_ID,
      already_done: false,
      migrated,
      quarantined,
      skipped,
      rebuilt_targets: rebuilt.targets,
      quarantine_dir: quarantineDir,
      marker_path: markerPath,
      ledger_path: ledgerPath()
    };
  });
}

export async function getLegacyLedgerMigrationStatus(): Promise<MigrationMarker | null> {
  return readJsonFile<MigrationMarker>(migrationMarkerPath());
}

/** Test helper: unique ids for quarantine filenames under contention. */
export function migrationIdForTests(): string {
  return `${MIGRATION_ID}-${randomUUID().slice(0, 8)}`;
}
