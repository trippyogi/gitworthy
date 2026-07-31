import { describe, expect, it } from 'vitest';
import {
  CheckResultSchema,
  ErrorResultSchema,
  SCHEMA_VERSION,
  toCheckResult,
  toErrorResult
} from '../src/contracts/index.js';
import { GitworthyError } from '../src/core/envelope.js';
import { packageVersion } from '../src/lib/package-meta.js';

describe('contracts', () => {
  it('lifts a legacy worth_check envelope into the versioned check result', () => {
    const result = toCheckResult({
      verdict_summary: 'Open PR #1 explicitly closes this issue.',
      evidence: [{ kind: 'linked_pr', number: 1, url: 'https://github.com/o/r/pull/1' }],
      signals: ['linked_pr_open'],
      checked: ['linked_work'],
      not_checked: ['duplicate check skipped'],
      cached: false,
      fetched_at: '2026-01-01T00:00:00.000Z',
      verdict: 'SKIP',
      disposition: 'land_only',
      reasons: ['open linked PR'],
      sub_results: [{ name: 'linked_work', ok: true, result: { cached: false } }],
      timings_ms: { linked_work: 12 },
      perf: { short_circuited: true }
    }, { repo: 'o/r', issue_number: 9 });

    expect(result.schema_version).toBe(SCHEMA_VERSION);
    expect(result.gitworthy_version).toBe(packageVersion());
    expect(result.command).toBe('check');
    expect(result.verdict).toBe('SKIP');
    expect(result.disposition).toBe('land_only');
    expect(result.decision_id).toMatch(/^decision_/);
    expect(result.run_id).toMatch(/^run_/);
    expect(result.checks[0]).toMatchObject({ id: 'linked_work', status: 'complete' });
    expect(result.signals).toEqual(['linked_pr_open']);
    expect(CheckResultSchema.parse(result).summary).toContain('Open PR #1');
  });

  it('emits LAND #N next_actions from land-pick findings', () => {
    const result = toCheckResult({
      verdict_summary: 'Open PR closes this issue.',
      evidence: [
        {
          kind: 'finding',
          id: 'f1',
          type: 'linked_pr_open',
          strength: 'definitive',
          effect: 'block',
          source: 'github_pull_request',
          message: 'PR #20 explicitly closes the issue.',
          data: { number: 20, land_pick: true }
        },
        {
          kind: 'finding',
          id: 'f2',
          type: 'competing_open_closer',
          strength: 'corroborated',
          effect: 'inform',
          source: 'github_pull_request',
          message: 'Competing open closer #10',
          data: { number: 10, primary: 20 }
        }
      ],
      signals: ['linked_pr_open'],
      checked: ['linked_work'],
      not_checked: ['n/a'],
      cached: false,
      fetched_at: '2026-01-01T00:00:00.000Z',
      verdict: 'SKIP',
      disposition: 'land_only'
    }, { repo: 'o/r', issue_number: 9 });

    expect(result.next_actions[0]).toMatchObject({
      kind: 'land',
      message: expect.stringContaining('LAND #20')
    });
    expect(result.next_actions[1]).toMatchObject({
      kind: 'coordinate',
      message: expect.stringContaining('#10')
    });
    expect(result.findings).toHaveLength(2);
  });

  it('emits CLOSE_CANDIDATE next_action for close_candidate findings', () => {
    const result = toCheckResult({
      verdict_summary: 'Merged linked PR; issue still open.',
      evidence: [{
        kind: 'finding',
        id: 'f1',
        type: 'close_candidate',
        strength: 'definitive',
        effect: 'verify',
        source: 'linked_work',
        message: 'CLOSE_CANDIDATE',
        data: {}
      }],
      signals: ['linked_pr_merged'],
      checked: ['linked_work'],
      not_checked: ['n/a'],
      cached: false,
      fetched_at: '2026-01-01T00:00:00.000Z',
      verdict: 'VERIFY',
      disposition: 'review'
    }, { repo: 'o/r', issue_number: 9 });

    expect(result.next_actions[0]?.message).toContain('CLOSE_CANDIDATE');
  });

  it('serializes GitworthyError into a versioned error result', () => {
    const error = toErrorResult({
      command: 'check',
      error: new GitworthyError({
        code: 'github_auth',
        message: 'token missing',
        checked: ['parsed command'],
        not_checked: ['GitHub API'],
        status: 401
      })
    });
    expect(error.ok).toBe(false);
    expect(error.error.category).toBe('auth');
    expect(error.error.retryable).toBe(false);
    expect(ErrorResultSchema.parse(error).schema_version).toBe(SCHEMA_VERSION);
  });

  it('maps plain invalid-ref errors to input category', () => {
    const error = toErrorResult({ command: 'check', error: new Error('Expected issue ref like owner/repo#123.') });
    expect(error.error.code).toBe('invalid_issue_ref');
    expect(error.error.category).toBe('input');
  });

  it('classifies missing token codes as auth', () => {
    const error = toErrorResult({
      command: 'check',
      error: new GitworthyError({ code: 'missing_github_token', message: 'GITHUB_TOKEN is required for this GitHub API check.' })
    });
    expect(error.error.category).toBe('auth');
  });

  it('classifies Zod contract failures as internal', () => {
    let caught: unknown;
    try {
      CheckResultSchema.parse({});
    } catch (error) {
      caught = error;
    }
    const error = toErrorResult({ command: 'check', error: caught });
    expect(error.error.code).toBe('contract_validation_failed');
    expect(error.error.category).toBe('internal');
  });

  it('classifies rate-limit exhausted 403 as network', () => {
    const error = toErrorResult({
      command: 'check',
      error: new GitworthyError({ code: 'github_rate_limit_exhausted', message: 'rate limited', status: 403 })
    });
    expect(error.error.category).toBe('network');
    expect(error.error.retryable).toBe(true);
  });

  it('classifies CLI usage errors as input', () => {
    const error = toErrorResult({ command: 'branch_scan', error: new Error('branches requires owner/repo and keywords.') });
    expect(error.error.code).toBe('invalid_usage');
    expect(error.error.category).toBe('input');
  });
});
