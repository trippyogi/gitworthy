import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDecisionId, newRunId } from '../src/contracts/common.js';
import { putDecisionRecord, putRunRecord } from '../src/lib/store.js';
import { exportStore, listDecisions, recordOutcome, showTarget } from '../src/lib/store-query.js';

describe('store query commands (GW-017)', () => {
  let storeDir: string;
  let previous: string | undefined;

  beforeEach(async () => {
    storeDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-store-query-'));
    previous = process.env.GITWORTHY_STORE_DIR;
    process.env.GITWORTHY_STORE_DIR = storeDir;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.GITWORTHY_STORE_DIR;
    else process.env.GITWORTHY_STORE_DIR = previous;
    await rm(storeDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('lists decisions, shows target, records outcomes, and exports', async () => {
    const runId = newRunId();
    const decisionId = newDecisionId();
    await putDecisionRecord({
      decision_id: decisionId,
      run_id: runId,
      created_at: '2026-01-01T00:00:00.000Z',
      target: { input_repo: 'o/r', canonical_repo: 'o/r', issue_number: 11 },
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
      target: { repo: 'o/r', issue_number: 11 },
      decision_id: decisionId,
      checked: ['x'],
      not_checked: ['y']
    });

    const decisions = await listDecisions({ repo: 'o/r', issue_number: 11 });
    expect(decisions).toHaveLength(1);

    const target = await showTarget('o/r', 11);
    expect(target.latest_decision?.decision_id).toBe(decisionId);

    const outcome = await recordOutcome({
      repo: 'o/r',
      issue_number: 11,
      event: 'selected',
      notes: 'picked for work'
    });
    expect(outcome.event).toBe('selected');

    const outDir = path.join(storeDir, 'export');
    const exported = await exportStore({ repo: 'o/r', issue_number: 11, out_dir: outDir });
    expect(exported).toMatchObject({ runs: 1, decisions: 1, outcomes: 1 });
    const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8')) as { decisions: number };
    expect(manifest.decisions).toBe(1);
  });
});
