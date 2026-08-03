import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { OutcomeEventSchema, assertOutcomeWrite } from '../src/contracts/outcomes.js';
import { TrackOExampleRowSchema } from '../src/contracts/track-o.js';
import { persistCheckResultBestEffort, putDecisionRecord, putOutcomeEvent, putRunRecord } from '../src/lib/store.js';
import { getTrackOCovariates } from '../src/lib/track-o-covariates.js';
import { recordOutcome } from '../src/lib/store-query.js';

describe('Track O Phase 0/1', () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-track-o-'));
    previous = process.env.GITWORTHY_STORE_DIR;
    process.env.GITWORTHY_STORE_DIR = dir;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.GITWORTHY_STORE_DIR;
    else process.env.GITWORTHY_STORE_DIR = previous;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('requires close_reason when writing closed_unmerged', async () => {
    await putRunRecord({
      run_id: 'run_o1',
      command: 'check',
      generated_at: '2026-08-03T00:00:00.000Z',
      summary: 'ok',
      target: { repo: 'acme/widgets', issue_number: 1 },
      decision_id: 'decision_o1'
    });
    await putDecisionRecord({
      decision_id: 'decision_o1',
      run_id: 'run_o1',
      created_at: '2026-08-03T00:00:00.000Z',
      target: {
        input_repo: 'acme/widgets',
        canonical_repo: 'acme/widgets',
        issue_number: 1
      },
      verdict: 'ACT',
      disposition: 'greenfield'
    });

    await expect(putOutcomeEvent({
      decision_id: 'decision_o1',
      run_id: 'run_o1',
      target: { repo: 'acme/widgets', issue_number: 1 },
      event: 'closed_unmerged',
      occurred_at: '2026-08-03T01:00:00.000Z',
      source: 'test'
    })).rejects.toThrow(/close-reason/);

    const ok = await putOutcomeEvent({
      decision_id: 'decision_o1',
      run_id: 'run_o1',
      target: { repo: 'acme/widgets', issue_number: 1 },
      event: 'closed_unmerged',
      close_reason: 'superseded',
      acted_against_skip: true,
      pr_url: 'https://github.com/acme/widgets/pull/9',
      occurred_at: '2026-08-03T01:00:00.000Z',
      source: 'test'
    });
    expect(ok.close_reason).toBe('superseded');
    expect(ok.acted_against_skip).toBe(true);
  });

  it('parses legacy closed_unmerged without close_reason on read', () => {
    const legacy = OutcomeEventSchema.parse({
      event_version: 1,
      event_id: 'outcome_legacy',
      decision_id: 'd',
      run_id: 'r',
      target: { repo: 'acme/widgets', issue_number: 1 },
      event: 'closed_unmerged',
      occurred_at: '2026-01-01T00:00:00.000Z',
      source: 'legacy',
      data: {},
      notes: ''
    });
    expect(legacy.close_reason).toBeUndefined();
    expect(() => assertOutcomeWrite(legacy)).toThrow(/close-reason/);
  });

  it('persists Track O covariates beside a check without coupling to verdict modules', async () => {
    await persistCheckResultBestEffort({
      run_id: 'run_cov',
      decision_id: 'decision_cov',
      generated_at: '2026-08-03T00:00:00.000Z',
      summary: 'ACT',
      target: {
        input_repo: 'acme/widgets',
        canonical_repo: 'acme/widgets',
        issue_number: 42
      },
      verdict: 'ACT',
      disposition: 'greenfield',
      signals: ['linked_pr_open'],
      findings: []
    });

    const cov = await getTrackOCovariates('decision_cov');
    expect(cov).toMatchObject({
      record_kind: 'track_o_covariates',
      decision_id: 'decision_cov',
      knowable_at_t0: true,
      covariates: { linked_pr_count_at_check: 1 }
    });

    const outcome = await recordOutcome({
      repo: 'acme/widgets',
      issue_number: 42,
      event: 'pr_opened',
      pr_url: 'https://github.com/acme/widgets/pull/42',
      source: 'test'
    });
    expect(outcome.pr_url).toContain('/pull/42');
  });

  it('accepts the Phase 0 worked example row', () => {
    const row = TrackOExampleRowSchema.parse({
      join: {
        decision_id: 'decision_example',
        run_id: 'run_example',
        repo: 'acme/widgets',
        issue_number: 76793,
        pr_url: 'https://github.com/acme/widgets/pull/100'
      },
      verdict_at_t0: 'ACT',
      disposition_at_t0: 'greenfield',
      acted_on: true,
      outcome_event: 'closed_unmerged',
      close_reason: 'superseded',
      acted_against_skip: false,
      reconstructed: false
    });
    expect(row.join.decision_id).toBe('decision_example');
  });

  it('keeps Track O covariates module out of verdict-path imports', () => {
    const forbiddenImporters = [
      'src/core/worth-check.ts',
      'src/core/hunt.ts',
      'src/core/linked-work.ts',
      'src/core/contention.ts',
      'src/core/dupe-cluster.ts',
      'src/core/branch-scan.ts',
      'src/core/issue-vs-main.ts',
      'src/core/release-gap.ts',
      'src/core/contrib-policy.ts'
    ];
    for (const rel of forbiddenImporters) {
      const text = readFileSync(path.join(process.cwd(), rel), 'utf8');
      expect(text).not.toMatch(/track-o-covariates/);
      expect(text).not.toMatch(/contracts\/track-o/);
    }
  });
});
