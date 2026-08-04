import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getDecisionRecord,
  getOutcomeEvent,
  getRunRecord,
  getTargetIndex,
  listDecisionIds,
  listOutcomeIds,
  listRunIds,
  putOutcomeEvent
} from './store.js';
import type { DecisionRecord, RunRecord, TargetIndex } from '../contracts/store.js';
import { OutcomeEventNameSchema, type OutcomeEvent } from '../contracts/outcomes.js';
import { z } from 'zod';

type OutcomeName = z.infer<typeof OutcomeEventNameSchema>;

function targetMatches(repo: string | undefined, issueNumber: number | undefined, candidateRepo: string, candidateIssue: number): boolean {
  if (repo && candidateRepo.toLowerCase() !== repo.toLowerCase()) return false;
  if (typeof issueNumber === 'number' && candidateIssue !== issueNumber) return false;
  return true;
}

export async function showRun(runId: string): Promise<RunRecord | null> {
  return getRunRecord(runId);
}

export async function showDecision(decisionId: string): Promise<DecisionRecord | null> {
  return getDecisionRecord(decisionId);
}

export async function showOutcome(eventId: string): Promise<OutcomeEvent | null> {
  return getOutcomeEvent(eventId);
}

export async function showTarget(repo: string, issueNumber: number): Promise<{
  index: TargetIndex | null;
  latest_decision: DecisionRecord | null;
  latest_run: RunRecord | null;
}> {
  const index = await getTargetIndex(repo, issueNumber);
  const latestDecisionId = index?.decision_ids[0];
  const latestRunId = index?.run_ids[0];
  return {
    index,
    latest_decision: latestDecisionId ? await getDecisionRecord(latestDecisionId) : null,
    latest_run: latestRunId ? await getRunRecord(latestRunId) : null
  };
}

export async function listRuns(input: { repo?: string; issue_number?: number; limit?: number } = {}): Promise<RunRecord[]> {
  const ids = await listRunIds();
  const rows: RunRecord[] = [];
  for (const id of ids) {
    const record = await getRunRecord(id);
    if (!record) continue;
    if (record.target && !targetMatches(input.repo, input.issue_number, record.target.repo, record.target.issue_number)) continue;
    if (!record.target && (input.repo || input.issue_number)) continue;
    rows.push(record);
  }
  rows.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  return typeof input.limit === 'number' ? rows.slice(0, Math.max(0, input.limit)) : rows;
}

export async function listDecisions(input: { repo?: string; issue_number?: number; limit?: number } = {}): Promise<DecisionRecord[]> {
  const ids = await listDecisionIds();
  const rows: DecisionRecord[] = [];
  for (const id of ids) {
    const record = await getDecisionRecord(id);
    if (!record) continue;
    if (!targetMatches(input.repo, input.issue_number, record.target.canonical_repo, record.target.issue_number)) continue;
    rows.push(record);
  }
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return typeof input.limit === 'number' ? rows.slice(0, Math.max(0, input.limit)) : rows;
}

export async function listOutcomes(input: { repo?: string; issue_number?: number; limit?: number } = {}): Promise<OutcomeEvent[]> {
  const ids = await listOutcomeIds();
  const rows: OutcomeEvent[] = [];
  for (const id of ids) {
    const event = await getOutcomeEvent(id);
    if (!event) continue;
    if (!targetMatches(input.repo, input.issue_number, event.target.repo, event.target.issue_number)) continue;
    rows.push(event);
  }
  rows.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || a.event_id.localeCompare(b.event_id));
  return typeof input.limit === 'number' ? rows.slice(0, Math.max(0, input.limit)) : rows;
}

export async function recordOutcome(input: {
  repo: string;
  issue_number: number;
  event: OutcomeName;
  decision_id?: string;
  run_id?: string;
  notes?: string;
  source?: string;
  data?: Record<string, unknown>;
  close_reason?: 'superseded' | 'stale' | 'withdrawn';
  acted_against_skip?: boolean;
  pr_url?: string;
  occurred_at?: string;
}): Promise<OutcomeEvent> {
  const index = await getTargetIndex(input.repo, input.issue_number);
  let decisionId = input.decision_id;
  let runId = input.run_id;

  if (decisionId && !runId) {
    const decision = await getDecisionRecord(decisionId);
    runId = decision?.run_id;
  } else if (runId && !decisionId) {
    const run = await getRunRecord(runId);
    runId = run?.run_id ?? runId;
    decisionId = run?.decision_id;
  } else if (!decisionId && !runId) {
    decisionId = index?.decision_ids[0];
    if (decisionId) {
      const decision = await getDecisionRecord(decisionId);
      runId = decision?.run_id ?? index?.run_ids[0];
    } else {
      runId = index?.run_ids[0];
    }
  }

  if (!decisionId || !runId) {
    throw new Error(`No stored decision/run for ${input.repo}#${input.issue_number}; run a check first or pass --decision-id and --run-id.`);
  }

  const decision = await getDecisionRecord(decisionId);
  if (decision && decision.run_id !== runId) {
    throw new Error(`decision ${decisionId} is linked to run ${decision.run_id}, not ${runId}.`);
  }
  return putOutcomeEvent({
    decision_id: decisionId,
    run_id: runId,
    target: { repo: input.repo.toLowerCase(), issue_number: input.issue_number },
    event: input.event,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    source: input.source ?? 'cli',
    data: input.data ?? {},
    notes: input.notes ?? '',
    close_reason: input.close_reason,
    acted_against_skip: input.acted_against_skip,
    pr_url: input.pr_url
  });
}

export async function exportStore(input: {
  repo?: string;
  issue_number?: number;
  out_dir: string;
}): Promise<{ out_dir: string; runs: number; decisions: number; outcomes: number }> {
  const [runs, decisions, outcomes] = await Promise.all([
    listRuns({ repo: input.repo, issue_number: input.issue_number }),
    listDecisions({ repo: input.repo, issue_number: input.issue_number }),
    listOutcomes({ repo: input.repo, issue_number: input.issue_number })
  ]);
  await mkdir(input.out_dir, { recursive: true });
  await writeFile(path.join(input.out_dir, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
  await writeFile(path.join(input.out_dir, 'decisions.json'), `${JSON.stringify(decisions, null, 2)}\n`);
  await writeFile(path.join(input.out_dir, 'outcomes.json'), `${JSON.stringify(outcomes, null, 2)}\n`);
  await writeFile(path.join(input.out_dir, 'manifest.json'), `${JSON.stringify({
    exported_at: new Date().toISOString(),
    repo: input.repo ?? null,
    issue_number: input.issue_number ?? null,
    runs: runs.length,
    decisions: decisions.length,
    outcomes: outcomes.length
  }, null, 2)}\n`);
  return { out_dir: input.out_dir, runs: runs.length, decisions: decisions.length, outcomes: outcomes.length };
}
