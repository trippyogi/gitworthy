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
});
