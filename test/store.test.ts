import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withStoreLock } from '../src/lib/store-fs.js';
import {
  getDecisionRecord,
  getOutcomeEvent,
  getRunRecord,
  getTargetIndex,
  putDecisionRecord,
  putOutcomeEvent,
  putRunRecord
} from '../src/lib/store.js';

describe('versioned store (GW-015)', () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-store-'));
    previous = process.env.GITWORTHY_STORE_DIR;
    process.env.GITWORTHY_STORE_DIR = dir;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.GITWORTHY_STORE_DIR;
    else process.env.GITWORTHY_STORE_DIR = previous;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('persists run, decision, and outcome records with a target index', async () => {
    const run = await putRunRecord({
      run_id: 'run_test1',
      command: 'check',
      generated_at: '2026-07-31T00:00:00.000Z',
      summary: 'check complete',
      target: { repo: 'o/r', issue_number: 9 },
      decision_id: 'decision_test1',
      checked: ['linked_work'],
      not_checked: ['n/a']
    });
    expect(run.record_kind).toBe('run');
    expect(await getRunRecord('run_test1')).toMatchObject({ run_id: 'run_test1', command: 'check' });

    const decision = await putDecisionRecord({
      decision_id: 'decision_test1',
      run_id: 'run_test1',
      created_at: '2026-07-31T00:00:00.000Z',
      target: {
        input_repo: 'o/r',
        canonical_repo: 'o/r',
        issue_number: 9,
        issue_url: 'https://github.com/o/r/issues/9'
      },
      verdict: 'ACT',
      disposition: 'greenfield',
      next_actions: [{ kind: 'proceed', message: 'go' }],
      findings: [],
      reasons: [],
      signals: []
    });
    expect(decision.verdict).toBe('ACT');
    expect(await getDecisionRecord('decision_test1')).toMatchObject({ decision_id: 'decision_test1' });

    const outcome = await putOutcomeEvent({
      event_id: 'outcome_test1',
      decision_id: 'decision_test1',
      run_id: 'run_test1',
      target: { repo: 'o/r', issue_number: 9 },
      event: 'selected',
      occurred_at: '2026-07-31T00:01:00.000Z',
      source: 'test',
      data: {},
      notes: ''
    });
    expect(outcome.event).toBe('selected');
    expect(await getOutcomeEvent('outcome_test1')).toMatchObject({ event_id: 'outcome_test1' });

    const index = await getTargetIndex('o/r', 9);
    expect(index).toMatchObject({
      run_ids: expect.arrayContaining(['run_test1']),
      decision_ids: expect.arrayContaining(['decision_test1']),
      outcome_ids: expect.arrayContaining(['outcome_test1'])
    });
  });

  it('serializes cross-process lock waiters without overlapping critical sections', async () => {
    const order: string[] = [];
    const first = withStoreLock('shared', async () => {
      order.push('a-enter');
      await new Promise((resolve) => setTimeout(resolve, 80));
      order.push('a-exit');
      return 'a';
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = withStoreLock('shared', async () => {
      order.push('b-enter');
      order.push('b-exit');
      return 'b';
    });
    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual(['a-enter', 'a-exit', 'b-enter', 'b-exit']);
  });

  it('times out when a lock is held past waitMs', async () => {
    const held = withStoreLock('busy', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return 'held';
    }, { waitMs: 500, staleMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(withStoreLock('busy', async () => 'nope', { waitMs: 40, staleMs: 5_000 }))
      .rejects.toMatchObject({ code: 'store_lock_timeout' });
    await expect(held).resolves.toBe('held');
  });
});
