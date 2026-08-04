import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putDecisionRecord, putOutcomeEvent, putRunRecord } from '../src/lib/store.js';
import {
  classifyPrTerminal,
  findTrackODebt,
  parsePrUrl,
  reconcileOutcomes,
  type PrTerminalSnapshot
} from '../src/lib/outcome-reconcile.js';
import { listOutcomes } from '../src/lib/store-query.js';

async function seedOpenLane(opts: {
  repo: string;
  issue: number;
  decision: string;
  run: string;
  pr_url?: string;
  event?: 'pr_opened' | 'selected';
}): Promise<void> {
  await putRunRecord({
    run_id: opts.run,
    command: 'check',
    generated_at: '2026-08-01T00:00:00.000Z',
    summary: 'ok',
    target: { repo: opts.repo, issue_number: opts.issue },
    decision_id: opts.decision
  });
  await putDecisionRecord({
    decision_id: opts.decision,
    run_id: opts.run,
    created_at: '2026-08-01T00:00:00.000Z',
    target: {
      input_repo: opts.repo,
      canonical_repo: opts.repo,
      issue_number: opts.issue,
      issue_url: `https://github.com/${opts.repo}/issues/${opts.issue}`
    },
    verdict: 'ACT',
    disposition: 'greenfield',
    reasons: ['test'],
    signals: []
  });
  await putOutcomeEvent({
    decision_id: opts.decision,
    run_id: opts.run,
    target: { repo: opts.repo.toLowerCase(), issue_number: opts.issue },
    event: opts.event ?? 'pr_opened',
    occurred_at: '2026-08-02T00:00:00.000Z',
    source: 'test',
    pr_url: opts.pr_url,
    notes: 'open lane'
  });
}

describe('outcome reconcile', () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-reconcile-'));
    previous = process.env.GITWORTHY_STORE_DIR;
    process.env.GITWORTHY_STORE_DIR = dir;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.GITWORTHY_STORE_DIR;
    else process.env.GITWORTHY_STORE_DIR = previous;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('parses GitHub pull URLs', () => {
    expect(parsePrUrl('https://github.com/acme/widgets/pull/42')).toEqual({
      repo: 'acme/widgets',
      number: 42
    });
    expect(parsePrUrl('https://example.com/acme/widgets/pull/42')).toBeNull();
  });

  it('classifies merged, withdrawn, and needs_adjudication', () => {
    const merged = classifyPrTerminal(
      {
        number: 1,
        title: 'fix',
        merged: true,
        state: 'closed',
        merged_at: '2026-08-03T00:00:00.000Z',
        closed_at: '2026-08-03T00:00:00.000Z',
        html_url: 'https://github.com/acme/widgets/pull/1',
        body: null,
        closed_by: null
      },
      'alice'
    );
    expect(merged.action).toBe('write');
    if (merged.action === 'write') expect(merged.event).toBe('merged');

    const withdrawn = classifyPrTerminal(
      {
        number: 2,
        title: 'wip',
        merged: false,
        state: 'closed',
        merged_at: null,
        closed_at: '2026-08-03T00:00:00.000Z',
        html_url: 'https://github.com/acme/widgets/pull/2',
        body: 'closing for now',
        closed_by: 'alice'
      },
      'alice'
    );
    expect(withdrawn.action).toBe('write');
    if (withdrawn.action === 'write') {
      expect(withdrawn.event).toBe('closed_unmerged');
      expect(withdrawn.close_reason).toBe('withdrawn');
    }

    const ambiguous = classifyPrTerminal(
      {
        number: 3,
        title: 'closed by maintainer',
        merged: false,
        state: 'closed',
        merged_at: null,
        closed_at: '2026-08-03T00:00:00.000Z',
        html_url: 'https://github.com/acme/widgets/pull/3',
        body: 'thanks but no',
        closed_by: 'maintainer'
      },
      'alice'
    );
    expect(ambiguous.action).toBe('needs_adjudication');
  });

  it('finds Track O debt for pr_opened without terminal', async () => {
    await seedOpenLane({
      repo: 'acme/widgets',
      issue: 10,
      decision: 'decision_d1',
      run: 'run_r1',
      pr_url: 'https://github.com/acme/widgets/pull/99'
    });
    const debt = await findTrackODebt();
    expect(debt.count).toBe(1);
    expect(debt.rows[0]?.issue_number).toBe(10);
  });

  it('does not treat selected without pr_url as debt', async () => {
    await seedOpenLane({
      repo: 'acme/widgets',
      issue: 11,
      decision: 'decision_d2',
      run: 'run_r2',
      event: 'selected'
    });
    const debt = await findTrackODebt();
    expect(debt.count).toBe(0);
  });

  it('dry-run proposes merged and write mode records once (idempotent)', async () => {
    await seedOpenLane({
      repo: 'acme/widgets',
      issue: 20,
      decision: 'decision_d3',
      run: 'run_r3',
      pr_url: 'https://github.com/acme/widgets/pull/20'
    });

    const snapshot: PrTerminalSnapshot = {
      number: 20,
      title: 'landed',
      merged: true,
      state: 'closed',
      merged_at: '2026-08-04T12:00:00.000Z',
      closed_at: '2026-08-04T12:00:00.000Z',
      html_url: 'https://github.com/acme/widgets/pull/20',
      body: null,
      closed_by: null
    };

    const dry = await reconcileOutcomes({
      dry_run: true,
      author: 'alice',
      fetchPr: async () => snapshot
    });
    expect(dry.wrote).toBe(1);
    expect(dry.items[0]?.status).toBe('dry_run');
    expect(dry.items[0]?.proposed_event).toBe('merged');
    expect((await listOutcomes({ repo: 'acme/widgets', issue_number: 20 })).some((e) => e.event === 'merged')).toBe(false);

    const write = await reconcileOutcomes({
      dry_run: false,
      author: 'alice',
      fetchPr: async () => snapshot
    });
    expect(write.wrote).toBe(1);
    expect(write.items[0]?.status).toBe('wrote');
    const after = await listOutcomes({ repo: 'acme/widgets', issue_number: 20 });
    expect(after.filter((e) => e.event === 'merged')).toHaveLength(1);
    expect(after.find((e) => e.event === 'merged')?.occurred_at).toBe('2026-08-04T12:00:00.000Z');

    const again = await reconcileOutcomes({
      dry_run: false,
      author: 'alice',
      fetchPr: async () => snapshot
    });
    expect(again.debt_count).toBe(0);
    expect(again.wrote).toBe(0);
  });

  it('queues needs_adjudication without writing', async () => {
    await seedOpenLane({
      repo: 'acme/widgets',
      issue: 30,
      decision: 'decision_d4',
      run: 'run_r4',
      pr_url: 'https://github.com/acme/widgets/pull/30'
    });

    const report = await reconcileOutcomes({
      dry_run: false,
      author: 'alice',
      fetchPr: async () => ({
        number: 30,
        title: 'nope',
        merged: false,
        state: 'closed',
        merged_at: null,
        closed_at: '2026-08-04T12:00:00.000Z',
        html_url: 'https://github.com/acme/widgets/pull/30',
        body: 'closed by review',
        closed_by: 'maintainer'
      })
    });
    expect(report.needs_adjudication).toBe(1);
    expect(report.wrote).toBe(0);
    expect((await listOutcomes({ repo: 'acme/widgets', issue_number: 30 })).some((e) => TERMINAL(e.event))).toBe(false);
  });
});

function TERMINAL(event: string): boolean {
  return ['merged', 'closed_unmerged', 'rejected', 'abandoned'].includes(event);
}
