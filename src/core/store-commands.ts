import { createEnvelope, Envelope, GitworthyError } from './envelope.js';
import { worth_check } from './worth-check.js';
import {
  exportStore,
  listDecisions,
  listOutcomes,
  listRuns,
  recordOutcome,
  showDecision,
  showOutcome,
  showRun,
  showTarget
} from '../lib/store-query.js';
import { CloseReasonSchema, OutcomeEventNameSchema } from '../contracts/outcomes.js';
import { persistCheckResultBestEffort, getDecisionRecord } from '../lib/store.js';
import { toCheckResult } from '../contracts/serialize.js';
import { reconcileOutcomes } from '../lib/outcome-reconcile.js';

export async function store_run_show(input: { run_id: string }): Promise<Envelope> {
  const record = await showRun(input.run_id);
  if (!record) {
    throw new GitworthyError({
      code: 'store_not_found',
      message: `Run ${input.run_id} was not found in the local store.`,
      not_checked: [`run ${input.run_id}`]
    });
  }
  return createEnvelope({
    verdict_summary: `run ${record.run_id} (${record.command}).`,
    evidence: [record],
    checked: [`loaded run ${record.run_id}`],
    not_checked: ['store browse does not re-validate GitHub state'],
    cached: true
  });
}

export async function store_run_list(input: { repo?: string; issue_number?: number; limit?: number } = {}): Promise<Envelope> {
  const rows = await listRuns(input);
  return createEnvelope({
    verdict_summary: `listed ${rows.length} run${rows.length === 1 ? '' : 's'}.`,
    evidence: rows,
    checked: ['listed durable run records'],
    not_checked: ['store browse does not re-validate GitHub state'],
    cached: true
  });
}

export async function store_decision_show(input: { decision_id: string }): Promise<Envelope> {
  const record = await showDecision(input.decision_id);
  if (!record) {
    throw new GitworthyError({
      code: 'store_not_found',
      message: `Decision ${input.decision_id} was not found in the local store.`,
      not_checked: [`decision ${input.decision_id}`]
    });
  }
  return createEnvelope({
    verdict_summary: `${record.verdict}/${record.disposition} for ${record.target.canonical_repo}#${record.target.issue_number}.`,
    evidence: [record],
    signals: [],
    checked: [`loaded decision ${record.decision_id}`],
    not_checked: ['store browse does not re-validate GitHub state'],
    cached: true
  });
}

export async function store_decision_list(input: { repo?: string; issue_number?: number; limit?: number } = {}): Promise<Envelope> {
  const rows = await listDecisions(input);
  return createEnvelope({
    verdict_summary: `listed ${rows.length} decision${rows.length === 1 ? '' : 's'}.`,
    evidence: rows,
    checked: ['listed durable decision records'],
    not_checked: ['store browse does not re-validate GitHub state'],
    cached: true
  });
}

export async function store_outcome_list(input: { repo?: string; issue_number?: number; limit?: number } = {}): Promise<Envelope> {
  const rows = await listOutcomes(input);
  return createEnvelope({
    verdict_summary: `listed ${rows.length} outcome${rows.length === 1 ? '' : 's'}.`,
    evidence: rows,
    checked: ['listed durable outcome events'],
    not_checked: ['store browse does not re-validate GitHub state'],
    cached: true
  });
}

export async function store_outcome_show(input: { event_id: string }): Promise<Envelope> {
  const event = await showOutcome(input.event_id);
  if (!event) {
    throw new GitworthyError({
      code: 'store_not_found',
      message: `Outcome ${input.event_id} was not found in the local store.`,
      not_checked: [`outcome ${input.event_id}`]
    });
  }
  return createEnvelope({
    verdict_summary: `outcome ${event.event} for ${event.target.repo}#${event.target.issue_number}.`,
    evidence: [event],
    checked: [`loaded outcome ${event.event_id}`],
    not_checked: ['store browse does not re-validate GitHub state'],
    cached: true
  });
}

export async function store_outcome_record(input: {
  repo: string;
  issue_number: number;
  event: string;
  decision_id?: string;
  run_id?: string;
  notes?: string;
  close_reason?: string;
  acted_against_skip?: boolean;
  pr_url?: string;
}): Promise<Envelope> {
  const eventName = OutcomeEventNameSchema.parse(input.event);
  const closeReason = input.close_reason !== undefined
    ? CloseReasonSchema.parse(input.close_reason)
    : undefined;
  try {
    const event = await recordOutcome({
      repo: input.repo,
      issue_number: input.issue_number,
      event: eventName,
      decision_id: input.decision_id,
      run_id: input.run_id,
      notes: input.notes,
      source: 'cli',
      close_reason: closeReason,
      acted_against_skip: input.acted_against_skip,
      pr_url: input.pr_url
    });
    return createEnvelope({
      verdict_summary: `recorded outcome ${event.event} for ${event.target.repo}#${event.target.issue_number}.`,
      evidence: [event],
      checked: [`wrote outcome ${event.event_id}`],
      not_checked: ['outcome recording does not re-run worth_check'],
      cached: false
    });
  } catch (error) {
    throw new GitworthyError({
      code: 'store_outcome_failed',
      message: error instanceof Error ? error.message : String(error),
      not_checked: ['outcome was not recorded']
    });
  }
}

/**
 * Reconcile open-lane Track O debt against live GitHub PR state.
 * Default dry_run=true; pass dry_run=false (CLI --write) to persist terminals.
 */
export async function store_outcome_reconcile(input: {
  dry_run?: boolean;
  write?: boolean;
  repo?: string;
  issue_number?: number;
  author?: string;
} = {}): Promise<Envelope> {
  if (input.write === true && input.dry_run === true) {
    throw new GitworthyError({
      code: 'invalid_usage',
      message: 'store_outcome_reconcile: pass write=true or dry_run=true, not both.',
      not_checked: ['outcome reconcile did not run']
    });
  }
  const dryRun = input.write === true ? false : input.dry_run !== false;
  try {
    const report = await reconcileOutcomes({
      dry_run: dryRun,
      repo: input.repo,
      issue_number: input.issue_number,
      author: input.author
    });
    const mode = report.dry_run ? 'dry-run' : 'write';
    return createEnvelope({
      verdict_summary:
        `outcome reconcile (${mode}): debt=${report.debt_count} wrote=${report.wrote} ` +
        `needs_adjudication=${report.needs_adjudication} skipped=${report.skipped}.`,
      evidence: [report],
      checked: [
        `scanned ${report.debt_count} Track O debt target(s)`,
        report.dry_run ? 'dry-run (no store writes)' : `wrote ${report.wrote} terminal outcome(s)`
      ],
      not_checked: [
        'reconcile does not auto-label superseded/rejected without clear signals',
        'reconcile does not promote to eval/frozen/'
      ],
      cached: false
    });
  } catch (error) {
    throw new GitworthyError({
      code: 'store_outcome_reconcile_failed',
      message: error instanceof Error ? error.message : String(error),
      not_checked: ['outcome reconcile did not complete']
    });
  }
}

export async function store_target_show(input: { repo: string; issue_number: number }): Promise<Envelope> {
  const view = await showTarget(input.repo, input.issue_number);
  return createEnvelope({
    verdict_summary: view.index
      ? `target ${input.repo}#${input.issue_number}: ${view.index.decision_ids.length} decision(s), ${view.index.run_ids.length} run(s), ${view.index.outcome_ids.length} outcome(s).`
      : `no store index for ${input.repo}#${input.issue_number}.`,
    evidence: [view],
    checked: [`loaded target index for ${input.repo}#${input.issue_number}`],
    not_checked: ['store browse does not re-validate GitHub state'],
    cached: true
  });
}

export async function store_export(input: { repo?: string; issue_number?: number; out_dir: string }): Promise<Envelope> {
  const report = await exportStore(input);
  return createEnvelope({
    verdict_summary: `exported ${report.runs} runs, ${report.decisions} decisions, ${report.outcomes} outcomes to ${report.out_dir}.`,
    evidence: [report],
    checked: [`wrote export bundle under ${report.out_dir}`],
    not_checked: ['export is a point-in-time local snapshot'],
    cached: false
  });
}

/** Re-run worth_check for a target and persist a fresh decision linked in the store. */
export async function store_recheck(input: {
  repo: string;
  issue_number: number;
  npm_package?: string;
}): Promise<Envelope> {
  const prior = await showTarget(input.repo, input.issue_number);
  const legacy = await worth_check({
    repo: input.repo,
    issue_number: input.issue_number,
    npm_package: input.npm_package
  });
  const check = toCheckResult(legacy as Record<string, unknown>, {
    repo: input.repo,
    issue_number: input.issue_number
  });
  await persistCheckResultBestEffort(check);
  const persisted = await getDecisionRecord(check.decision_id);
  return createEnvelope({
    verdict_summary: `recheck ${check.verdict}/${check.disposition} for ${input.repo}#${input.issue_number}.`,
    evidence: [
      {
        kind: 'recheck',
        prior_decision_id: prior.latest_decision?.decision_id ?? null,
        prior_run_id: prior.latest_run?.run_id ?? null,
        decision_id: check.decision_id,
        run_id: check.run_id,
        verdict: check.verdict,
        disposition: check.disposition,
        persisted: Boolean(persisted)
      },
      check
    ],
    signals: [],
    checked: [
      `re-ran worth_check for ${input.repo}#${input.issue_number}`,
      ...(persisted ? [`persisted decision ${check.decision_id}`] : [])
    ],
    not_checked: [
      ...(persisted ? [] : ['decision persistence failed; ids in evidence may not exist on disk']),
      ...(prior.index
        ? ['prior decision retained in store history; compare decision ids manually']
        : ['no prior store decision existed for this target'])
    ],
    cached: false
  });
}
