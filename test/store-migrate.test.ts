import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertLedgerEntry } from '../src/lib/ledger.js';
import { getDecisionRecord, getTargetIndex, putDecisionRecord, putRunRecord, rebuildTargetIndexes } from '../src/lib/store.js';
import { migrateLegacyLedger } from '../src/lib/store-migrate.js';
import { newDecisionId, newRunId } from '../src/contracts/common.js';

describe('legacy ledger migration (GW-016)', () => {
  let ledgerDir: string;
  let storeDir: string;
  let previousLedger: string | undefined;
  let previousStore: string | undefined;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-ledger-mig-'));
    storeDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-store-mig-'));
    previousLedger = process.env.GITWORTHY_LEDGER_DIR;
    previousStore = process.env.GITWORTHY_STORE_DIR;
    process.env.GITWORTHY_LEDGER_DIR = ledgerDir;
    process.env.GITWORTHY_STORE_DIR = storeDir;
  });

  afterEach(async () => {
    if (previousLedger === undefined) delete process.env.GITWORTHY_LEDGER_DIR;
    else process.env.GITWORTHY_LEDGER_DIR = previousLedger;
    if (previousStore === undefined) delete process.env.GITWORTHY_STORE_DIR;
    else process.env.GITWORTHY_STORE_DIR = previousStore;
    await rm(ledgerDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(storeDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('migrates valid ledger entries into store decisions and is idempotent', async () => {
    await upsertLedgerEntry({
      repo: 'o/r',
      issue_number: 7,
      verdict: 'SKIP',
      disposition: 'land_only',
      notes: 'already claimed',
      source: 'worth_check'
    });

    const first = await migrateLegacyLedger();
    expect(first.already_done).toBe(false);
    expect(first.migrated).toBe(1);
    expect(first.quarantined).toBe(0);
    expect(first.rebuilt_targets).toBe(1);

    const index = await getTargetIndex('o/r', 7);
    expect(index?.decision_ids.length).toBe(1);
    const decision = await getDecisionRecord(index!.decision_ids[0]!);
    expect(decision).toMatchObject({
      verdict: 'SKIP',
      disposition: 'land_only',
      target: expect.objectContaining({ canonical_repo: 'o/r', issue_number: 7 })
    });

    const second = await migrateLegacyLedger();
    expect(second.already_done).toBe(true);
    expect(second.migrated).toBe(1);
  });

  it('quarantines corrupt ledger JSON and invalid entries', async () => {
    await writeFile(path.join(ledgerDir, 'entries.json'), '{not-json', 'utf8');
    const report = await migrateLegacyLedger();
    expect(report.migrated).toBe(0);
    expect(report.quarantined).toBeGreaterThanOrEqual(1);

    await writeFile(
      path.join(ledgerDir, 'entries.json'),
      JSON.stringify({
        bad: { repo: 'nope', issue_number: 'x' },
        good: {
          repo: 'a/b',
          issue_number: 1,
          recorded_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          verdict: 'ACT',
          disposition: 'greenfield'
        }
      }, null, 2),
      'utf8'
    );
    const forced = await migrateLegacyLedger({ force: true });
    expect(forced.migrated).toBe(1);
    expect(forced.quarantined).toBeGreaterThanOrEqual(1);
  });

  it('rebuilds target indexes from durable records', async () => {
    const runId = newRunId();
    const decisionId = newDecisionId();
    await putDecisionRecord({
      decision_id: decisionId,
      run_id: runId,
      created_at: '2026-01-01T00:00:00.000Z',
      target: { input_repo: 'o/r', canonical_repo: 'o/r', issue_number: 3 },
      verdict: 'ACT',
      disposition: 'greenfield',
      next_actions: [],
      findings: [],
      reasons: [],
      signals: []
    });
    await putRunRecord({
      run_id: runId,
      command: 'check',
      generated_at: '2026-01-01T00:00:00.000Z',
      summary: 'ok',
      target: { repo: 'o/r', issue_number: 3 },
      decision_id: decisionId,
      checked: ['x'],
      not_checked: ['y']
    });

    const rebuilt = await rebuildTargetIndexes();
    expect(rebuilt.targets).toBe(1);
    expect(rebuilt.decisions).toBe(1);
    expect(rebuilt.runs).toBe(1);
    const index = await getTargetIndex('o/r', 3);
    expect(index).toMatchObject({
      decision_ids: [decisionId],
      run_ids: expect.arrayContaining([runId])
    });
  });
});
