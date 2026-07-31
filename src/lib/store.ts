import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DecisionRecordSchema,
  RunRecordSchema,
  TargetIndexSchema,
  type DecisionRecord,
  type RunRecord,
  type TargetIndex
} from '../contracts/store.js';
import { OutcomeEventSchema, type OutcomeEvent } from '../contracts/outcomes.js';
import { packageVersion } from './package-meta.js';
import { readJsonFile, storeRoot, withStoreLock, writeJsonAtomic } from './store-fs.js';
import { SCHEMA_VERSION } from '../contracts/common.js';

const INDEX_RUN_CAP = 100;
const INDEX_DECISION_CAP = 100;
const INDEX_OUTCOME_CAP = 200;

function runsDir(): string {
  return path.join(storeRoot(), 'runs');
}

function decisionsDir(): string {
  return path.join(storeRoot(), 'decisions');
}

function outcomesDir(): string {
  return path.join(storeRoot(), 'outcomes');
}

function indexesDir(): string {
  return path.join(storeRoot(), 'indexes', 'targets');
}

function targetKey(repo: string, issueNumber: number): string {
  return `${repo.toLowerCase().replace(/[\\/]/g, '__')}#${issueNumber}`;
}

function runPath(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}

function decisionPath(decisionId: string): string {
  return path.join(decisionsDir(), `${decisionId}.json`);
}

function outcomePath(eventId: string): string {
  return path.join(outcomesDir(), `${eventId}.json`);
}

function targetIndexPath(repo: string, issueNumber: number): string {
  return path.join(indexesDir(), `${targetKey(repo, issueNumber)}.json`);
}

function pushCapped(list: string[], id: string, cap: number): string[] {
  const next = [id, ...list.filter((item) => item !== id)];
  return next.slice(0, cap);
}

async function updateTargetIndex(
  target: { repo: string; issue_number: number },
  patch: { runId?: string; decisionId?: string; outcomeId?: string }
): Promise<TargetIndex> {
  const file = targetIndexPath(target.repo, target.issue_number);
  const existing = await readJsonFile<unknown>(file);
  const base = existing
    ? TargetIndexSchema.parse(existing)
    : TargetIndexSchema.parse({
      record_version: 1,
      record_kind: 'target_index',
      target: { repo: target.repo.toLowerCase(), issue_number: target.issue_number },
      updated_at: new Date().toISOString(),
      run_ids: [],
      decision_ids: [],
      outcome_ids: []
    });

  const next: TargetIndex = {
    ...base,
    target: { repo: target.repo.toLowerCase(), issue_number: target.issue_number },
    updated_at: new Date().toISOString(),
    run_ids: patch.runId ? pushCapped(base.run_ids, patch.runId, INDEX_RUN_CAP) : base.run_ids,
    decision_ids: patch.decisionId ? pushCapped(base.decision_ids, patch.decisionId, INDEX_DECISION_CAP) : base.decision_ids,
    outcome_ids: patch.outcomeId ? pushCapped(base.outcome_ids, patch.outcomeId, INDEX_OUTCOME_CAP) : base.outcome_ids
  };
  const parsed = TargetIndexSchema.parse(next);
  await writeJsonAtomic(file, parsed);
  return parsed;
}

export async function putRunRecord(input: Omit<RunRecord, 'record_version' | 'record_kind' | 'schema_version' | 'gitworthy_version'> & Partial<Pick<RunRecord, 'schema_version' | 'gitworthy_version'>>): Promise<RunRecord> {
  const record = RunRecordSchema.parse({
    record_version: 1,
    record_kind: 'run',
    schema_version: input.schema_version ?? SCHEMA_VERSION,
    gitworthy_version: input.gitworthy_version ?? packageVersion(),
    ...input
  });

  return withStoreLock(`run:${record.run_id}`, async () => {
    await writeJsonAtomic(runPath(record.run_id), record);
    if (record.target) {
      await withStoreLock(`target:${targetKey(record.target.repo, record.target.issue_number)}`, async () => {
        await updateTargetIndex(record.target!, { runId: record.run_id });
      });
    }
    return record;
  });
}

export async function putDecisionRecord(input: Omit<DecisionRecord, 'record_version' | 'record_kind' | 'schema_version' | 'gitworthy_version'> & Partial<Pick<DecisionRecord, 'schema_version' | 'gitworthy_version'>>): Promise<DecisionRecord> {
  const record = DecisionRecordSchema.parse({
    record_version: 1,
    record_kind: 'decision',
    schema_version: input.schema_version ?? SCHEMA_VERSION,
    gitworthy_version: input.gitworthy_version ?? packageVersion(),
    ...input
  });

  return withStoreLock(`decision:${record.decision_id}`, async () => {
    await writeJsonAtomic(decisionPath(record.decision_id), record);
    await withStoreLock(`target:${targetKey(record.target.canonical_repo, record.target.issue_number)}`, async () => {
      await updateTargetIndex(
        { repo: record.target.canonical_repo, issue_number: record.target.issue_number },
        { decisionId: record.decision_id, runId: record.run_id }
      );
    });
    return record;
  });
}

export async function putOutcomeEvent(input: Omit<OutcomeEvent, 'event_version' | 'event_id'> & { event_id?: string }): Promise<OutcomeEvent> {
  const event = OutcomeEventSchema.parse({
    event_version: 1,
    event_id: input.event_id ?? `outcome_${randomUUID().replace(/-/g, '')}`,
    ...input
  });

  return withStoreLock(`outcome:${event.event_id}`, async () => {
    await writeJsonAtomic(outcomePath(event.event_id), event);
    await withStoreLock(`target:${targetKey(event.target.repo, event.target.issue_number)}`, async () => {
      await updateTargetIndex(event.target, { outcomeId: event.event_id, runId: event.run_id, decisionId: event.decision_id });
    });
    return event;
  });
}

export async function getRunRecord(runId: string): Promise<RunRecord | null> {
  const raw = await readJsonFile<unknown>(runPath(runId));
  return raw ? RunRecordSchema.parse(raw) : null;
}

export async function getDecisionRecord(decisionId: string): Promise<DecisionRecord | null> {
  const raw = await readJsonFile<unknown>(decisionPath(decisionId));
  return raw ? DecisionRecordSchema.parse(raw) : null;
}

export async function getOutcomeEvent(eventId: string): Promise<OutcomeEvent | null> {
  const raw = await readJsonFile<unknown>(outcomePath(eventId));
  return raw ? OutcomeEventSchema.parse(raw) : null;
}

export async function getTargetIndex(repo: string, issueNumber: number): Promise<TargetIndex | null> {
  const raw = await readJsonFile<unknown>(targetIndexPath(repo, issueNumber));
  return raw ? TargetIndexSchema.parse(raw) : null;
}

/** Best-effort persist of a check result into run + decision records. Never throws to callers. */
export async function persistCheckResultBestEffort(result: {
  run_id: string;
  decision_id: string;
  command?: string;
  generated_at: string;
  cached?: boolean;
  summary: string;
  checked?: string[];
  not_checked?: string[];
  metrics?: Record<string, unknown>;
  target: {
    input_repo: string;
    canonical_repo: string;
    issue_number: number;
    issue_state?: string;
    issue_url?: string;
    head_sha?: string;
  };
  verdict: DecisionRecord['verdict'];
  disposition: DecisionRecord['disposition'];
  next_actions?: DecisionRecord['next_actions'];
  findings?: DecisionRecord['findings'];
  reasons?: string[];
  signals?: string[];
  gitworthy_version?: string;
  schema_version?: string;
}): Promise<void> {
  try {
    await putRunRecord({
      run_id: result.run_id,
      command: result.command ?? 'check',
      generated_at: result.generated_at,
      cached: result.cached ?? false,
      summary: result.summary,
      target: { repo: result.target.canonical_repo, issue_number: result.target.issue_number },
      decision_id: result.decision_id,
      checked: result.checked ?? [],
      not_checked: result.not_checked ?? [],
      metrics: result.metrics ?? {},
      gitworthy_version: result.gitworthy_version,
      schema_version: result.schema_version as RunRecord['schema_version'] | undefined
    });
    await putDecisionRecord({
      decision_id: result.decision_id,
      run_id: result.run_id,
      created_at: result.generated_at,
      target: result.target,
      verdict: result.verdict,
      disposition: result.disposition,
      next_actions: result.next_actions ?? [],
      findings: result.findings ?? [],
      reasons: result.reasons ?? [],
      signals: result.signals ?? [],
      gitworthy_version: result.gitworthy_version,
      schema_version: result.schema_version as DecisionRecord['schema_version'] | undefined
    });
  } catch {
    // Durable store is best-effort; never fail a check because persistence failed.
  }
}
