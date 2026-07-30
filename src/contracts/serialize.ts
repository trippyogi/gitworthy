import { ZodError } from 'zod';
import { packageVersion } from '../lib/package-meta.js';
import { GitworthyError } from '../core/envelope.js';
import { CheckResult, CheckResultSchema } from './check.js';
import { SCHEMA_VERSION, newDecisionId, newRunId } from './common.js';
import { ErrorResult, ErrorResultSchema, type ErrorDetail } from './errors.js';
import { DoctorResultSchema } from './doctor.js';
import { HuntResultSchema } from './hunt.js';
import { LedgerResultSchema } from './ledger.js';
import { ScanResultSchema } from './scan.js';

export type CommandName = 'check' | 'scan' | 'hunt' | 'doctor' | 'ledger_list' | 'ledger_show' | 'ledger_record' | 'ledger_lookup' | string;

type LegacyEnvelopeLike = {
  verdict_summary?: string;
  evidence?: Array<Record<string, unknown>>;
  signals?: string[];
  checked?: string[];
  not_checked?: string[];
  cached?: boolean;
  fetched_at?: string;
  verdict?: 'ACT' | 'VERIFY' | 'SKIP';
  disposition?: CheckResult['disposition'];
  reasons?: string[];
  sub_results?: unknown[];
  timings_ms?: Record<string, number>;
  perf?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapSubResultsToChecks(subResults: unknown[] | undefined): CheckResult['checks'] {
  if (!subResults) return [];
  return subResults.map((item) => {
    const row = asRecord(item);
    const name = typeof row.name === 'string' ? row.name : 'unknown';
    if (row.ok === true) {
      const result = asRecord(row.result);
      return {
        id: name,
        status: 'complete' as const,
        cached: typeof result.cached === 'boolean' ? result.cached : undefined
      };
    }
    return { id: name, status: 'failed' as const };
  });
}

function nextActionsFor(legacy: LegacyEnvelopeLike): CheckResult['next_actions'] {
  if (legacy.verdict === 'SKIP' && legacy.disposition === 'land_only') {
    return [{ kind: 'land', message: 'Review or help land the open linked PR. Do not open a parallel implementation.' }];
  }
  if (legacy.verdict === 'VERIFY' && legacy.disposition === 'claim_first') {
    return [{ kind: 'coordinate', message: 'Request assignment or follow the claim protocol before opening a pull request.' }];
  }
  if (legacy.verdict === 'VERIFY') {
    return [{ kind: 'verify', message: legacy.verdict_summary ?? 'Perform the named human verification steps before investing.' }];
  }
  if (legacy.verdict === 'ACT') {
    return [{ kind: 'proceed', message: 'Completed mandatory checks found no reason to stop; still re-check before a public action.' }];
  }
  return [];
}

/** Lift a legacy worth_check envelope into the versioned check contract (compat fields preserved). */
export function toCheckResult(legacy: LegacyEnvelopeLike & Record<string, unknown>, input: { repo: string; issue_number: number }): CheckResult {
  const generatedAt = typeof legacy.fetched_at === 'string' ? legacy.fetched_at : new Date().toISOString();
  const summary = legacy.verdict_summary ?? legacy.verdict ?? 'check complete';
  const duration = legacy.timings_ms ? Object.values(legacy.timings_ms).reduce((sum, value) => sum + value, 0) : undefined;
  const payload = {
    schema_version: SCHEMA_VERSION,
    gitworthy_version: packageVersion(),
    command: 'check' as const,
    run_id: newRunId(),
    decision_id: newDecisionId(),
    generated_at: generatedAt,
    cached: legacy.cached ?? false,
    summary,
    checked: legacy.checked ?? ['check'],
    not_checked: legacy.not_checked ?? ['limitations not recorded'],
    checks: mapSubResultsToChecks(legacy.sub_results),
    findings: [],
    metrics: { duration_ms: duration },
    target: {
      input_repo: input.repo,
      canonical_repo: input.repo,
      issue_number: input.issue_number,
      issue_url: `https://github.com/${input.repo}/issues/${input.issue_number}`
    },
    verdict: legacy.verdict ?? 'VERIFY',
    disposition: legacy.disposition ?? 'review',
    next_actions: nextActionsFor(legacy),
    verdict_summary: legacy.verdict_summary,
    evidence: legacy.evidence,
    signals: legacy.signals,
    reasons: legacy.reasons,
    sub_results: legacy.sub_results,
    timings_ms: legacy.timings_ms,
    perf: legacy.perf,
    fetched_at: legacy.fetched_at
  };
  return CheckResultSchema.parse(payload);
}

export function toStampedLegacyResult(command: CommandName, legacy: Record<string, unknown>) {
  const generatedAt = typeof legacy.fetched_at === 'string' ? legacy.fetched_at : new Date().toISOString();
  const summary = typeof legacy.verdict_summary === 'string' ? legacy.verdict_summary : `${command} complete`;
  const stamped = {
    ...legacy,
    schema_version: SCHEMA_VERSION,
    gitworthy_version: packageVersion(),
    command,
    run_id: newRunId(),
    generated_at: generatedAt,
    cached: typeof legacy.cached === 'boolean' ? legacy.cached : false,
    summary,
    checked: Array.isArray(legacy.checked) && legacy.checked.length > 0 ? legacy.checked : [`ran ${command}`],
    not_checked: Array.isArray(legacy.not_checked) && legacy.not_checked.length > 0 ? legacy.not_checked : ['full 1.0 contract mapping not yet applied for this command'],
    checks: Array.isArray(legacy.checks) ? legacy.checks : [],
    findings: Array.isArray(legacy.findings) ? legacy.findings : [],
    metrics: typeof legacy.metrics === 'object' && legacy.metrics !== null ? legacy.metrics : {}
  };

  if (command === 'scan') return ScanResultSchema.parse(stamped);
  if (command === 'hunt') return HuntResultSchema.parse(stamped);
  if (command === 'doctor') return DoctorResultSchema.parse(stamped);
  if (command === 'ledger_list' || command === 'ledger_show' || command === 'ledger_record' || command === 'ledger_lookup') {
    return LedgerResultSchema.parse({ ...stamped, command });
  }
  return stamped;
}

function categorize(code: string, status?: number): ErrorDetail['category'] {
  const normalized = code.toLowerCase();
  if (
    normalized.includes('auth')
    || normalized.includes('token')
    || normalized.includes('unauthorized')
    || status === 401
    || status === 403
  ) {
    return 'auth';
  }
  if (normalized.includes('rate') || status === 429) return 'network';
  if (normalized.includes('invalid') || normalized.includes('parse') || normalized.includes('input')) return 'input';
  if (normalized.includes('budget') || normalized.includes('timeout')) return 'budget';
  if (normalized.includes('contract') || normalized.includes('schema')) return 'internal';
  if (status && status >= 500) return 'provider';
  if (status && status >= 400) return 'provider';
  return 'internal';
}

export function toErrorResult(input: {
  command: string;
  error: GitworthyError | Error | unknown;
  run_id?: string;
}): ErrorResult {
  const runId = input.run_id ?? newRunId();
  if (input.error instanceof GitworthyError) {
    return ErrorResultSchema.parse({
      schema_version: SCHEMA_VERSION,
      gitworthy_version: packageVersion(),
      ok: false,
      command: input.command,
      run_id: runId,
      error: {
        code: input.error.code,
        category: categorize(input.error.code, input.error.status),
        message: input.error.message,
        retryable: input.error.status === 429 || (input.error.status !== undefined && input.error.status >= 500),
        status: input.error.status ?? null,
        details: {
          github_message: input.error.github_message,
          documentation_url: input.error.documentation_url
        }
      },
      checked: input.error.checked.length > 0 ? input.error.checked : ['parsed command name'],
      not_checked: input.error.not_checked.length > 0 ? input.error.not_checked : [input.error.message],
      generated_at: new Date().toISOString()
    });
  }

  if (input.error instanceof ZodError) {
    return ErrorResultSchema.parse({
      schema_version: SCHEMA_VERSION,
      gitworthy_version: packageVersion(),
      ok: false,
      command: input.command,
      run_id: runId,
      error: {
        code: 'contract_validation_failed',
        category: 'internal',
        message: 'Result failed contract validation.',
        retryable: false,
        status: null,
        details: { issues: input.error.issues }
      },
      checked: ['parsed command name'],
      not_checked: ['Result could not be validated against the versioned contract.'],
      generated_at: new Date().toISOString()
    });
  }

  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const lower = message.toLowerCase();
  const looksLikeIssueRef = lower.includes('expected issue ref') || lower.includes('owner/repo#');
  const code = looksLikeIssueRef ? 'invalid_issue_ref' : 'internal_error';
  return ErrorResultSchema.parse({
    schema_version: SCHEMA_VERSION,
    gitworthy_version: packageVersion(),
    ok: false,
    command: input.command,
    run_id: runId,
    error: {
      code,
      category: categorize(code),
      message,
      retryable: false,
      status: null,
      details: {}
    },
    checked: ['parsed command name'],
    not_checked: [message],
    generated_at: new Date().toISOString()
  });
}
