/**
 * Track O Phase 1.5 — reconcile open-lane outcomes against live GitHub PR state.
 *
 * Joins existing decision_id only. Never creates reconstructed decisions.
 * Auto-writes clear terminals (merged / author-withdrawn); queues ambiguous closes.
 */
import { githubJson } from './github.js';
import { listOutcomes, recordOutcome } from './store-query.js';
import type { CloseReason, OutcomeEvent, OutcomeEventName } from '../contracts/outcomes.js';

export const TERMINAL_OUTCOME_EVENTS = new Set<OutcomeEventName>([
  'merged',
  'closed_unmerged',
  'rejected',
  'abandoned',
  'duplicate_confirmed',
  'already_fixed_confirmed',
  'maintainer_redirected'
]);

export const OPEN_LANE_EVENTS = new Set<OutcomeEventName>(['pr_opened', 'selected']);

export type PrTerminalSnapshot = {
  number: number;
  title: string;
  merged: boolean;
  state: string;
  merged_at: string | null;
  closed_at: string | null;
  html_url: string;
  body: string | null;
  closed_by: string | null;
};

export type ClassifyWrite = {
  action: 'write';
  event: 'merged' | 'rejected' | 'closed_unmerged';
  close_reason?: CloseReason;
  note: string;
  occurred_at: string;
};

export type ClassifyResult =
  | { action: 'open'; note: string }
  | ClassifyWrite
  | { action: 'needs_adjudication'; note: string; occurred_at: string; closer: string | null };

export type TrackODebtRow = {
  repo: string;
  issue_number: number;
  decision_id: string;
  run_id: string;
  pr_url?: string;
  latest_open_event: OutcomeEventName;
  occurred_at: string;
};

export type ReconcileItem = {
  repo: string;
  issue_number: number;
  decision_id: string;
  run_id: string;
  pr_url?: string;
  status:
    | 'wrote'
    | 'dry_run'
    | 'skipped_terminal'
    | 'still_open'
    | 'needs_adjudication'
    | 'missing_pr_url'
    | 'error';
  proposed_event?: OutcomeEventName;
  close_reason?: CloseReason;
  note: string;
  event_id?: string;
};

export type ReconcileReport = {
  dry_run: boolean;
  author: string | null;
  debt_count: number;
  wrote: number;
  skipped: number;
  needs_adjudication: number;
  items: ReconcileItem[];
};

type GhPull = {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  merged_at: string | null;
  closed_at: string | null;
  html_url: string;
  body: string | null;
};

type GhIssue = {
  closed_by: { login: string } | null;
};

function targetKey(repo: string, issueNumber: number): string {
  return `${repo.toLowerCase()}#${issueNumber}`;
}

/** Parse owner/repo#N from a GitHub pull URL. */
export function parsePrUrl(prUrl: string): { repo: string; number: number } | null {
  try {
    const u = new URL(prUrl);
    if (!/github\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/i);
    if (!m) return null;
    return { repo: m[1]!, number: Number(m[2]) };
  } catch {
    return null;
  }
}

export function classifyPrTerminal(
  pr: Pick<PrTerminalSnapshot, 'merged' | 'merged_at' | 'closed_at' | 'state' | 'body' | 'closed_by' | 'html_url' | 'title' | 'number'>,
  author: string
): ClassifyResult {
  const occurred_at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString();

  if (pr.merged) {
    return {
      action: 'write',
      event: 'merged',
      note: 'merged into default branch',
      occurred_at
    };
  }

  const state = (pr.state ?? '').toLowerCase();
  if (state === 'open' || (!pr.closed_at && !pr.merged)) {
    return { action: 'open', note: 'PR still open' };
  }

  const body = (pr.body ?? '').toLowerCase();
  if (/superseded by|already (fixed|landed|merged)|duplicate of #|closed in favor of|replaced by #/i.test(body)) {
    return {
      action: 'write',
      event: 'closed_unmerged',
      close_reason: 'superseded',
      note: 'body indicates supersession',
      occurred_at
    };
  }

  const closedBy = pr.closed_by;
  if (closedBy && closedBy.toLowerCase() === author.toLowerCase()) {
    if (/\b(maintainers? (rejected|declined)|wontfix|won't fix|not interested)\b/i.test(body)) {
      return {
        action: 'write',
        event: 'rejected',
        note: 'body explicitly indicates maintainer rejection',
        occurred_at
      };
    }
    return {
      action: 'write',
      event: 'closed_unmerged',
      close_reason: 'withdrawn',
      note: 'closed unmerged by author; defaulting to withdrawn — re-adjudicate if wrong',
      occurred_at
    };
  }

  return {
    action: 'needs_adjudication',
    note: `closed unmerged; closer=${closedBy ?? 'unknown'} — do not auto-label`,
    occurred_at,
    closer: closedBy
  };
}

export function hasTerminalOutcome(events: OutcomeEvent[]): boolean {
  return events.some((e) => TERMINAL_OUTCOME_EVENTS.has(e.event));
}

export function isOpenLaneDebt(events: OutcomeEvent[]): boolean {
  if (hasTerminalOutcome(events)) return false;
  const hasPrOpened = events.some((e) => e.event === 'pr_opened');
  const hasSelectedWithPr = events.some((e) => e.event === 'selected' && Boolean(e.pr_url));
  return hasPrOpened || hasSelectedWithPr;
}

function pickPrUrl(events: OutcomeEvent[]): string | undefined {
  for (const e of events) {
    if (e.pr_url) return e.pr_url;
    const dataUrl = e.data?.url;
    if (typeof dataUrl === 'string' && /\/pull\/\d+/i.test(dataUrl)) return dataUrl;
  }
  return undefined;
}

function pickOpenLaneEvent(events: OutcomeEvent[]): OutcomeEvent | undefined {
  const prOpened = events.find((e) => e.event === 'pr_opened');
  if (prOpened) return prOpened;
  return events.find((e) => e.event === 'selected' && Boolean(e.pr_url));
}

/** Local-only scan: targets with open-lane events and no terminal. */
export async function findTrackODebt(input: {
  repo?: string;
  issue_number?: number;
} = {}): Promise<{ count: number; rows: TrackODebtRow[] }> {
  const outcomes = await listOutcomes({
    repo: input.repo,
    issue_number: input.issue_number,
    limit: 50_000
  });

  const byTarget = new Map<string, OutcomeEvent[]>();
  for (const event of outcomes) {
    const key = targetKey(event.target.repo, event.target.issue_number);
    const rows = byTarget.get(key) ?? [];
    rows.push(event);
    byTarget.set(key, rows);
  }

  const rows: TrackODebtRow[] = [];
  for (const [, events] of byTarget) {
    if (!isOpenLaneDebt(events)) continue;
    const lane = pickOpenLaneEvent(events);
    if (!lane) continue;
    rows.push({
      repo: lane.target.repo,
      issue_number: lane.target.issue_number,
      decision_id: lane.decision_id,
      run_id: lane.run_id,
      pr_url: pickPrUrl(events),
      latest_open_event: lane.event,
      occurred_at: lane.occurred_at
    });
  }

  rows.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  return { count: rows.length, rows };
}

export async function fetchPrTerminalSnapshot(repo: string, prNumber: number): Promise<PrTerminalSnapshot> {
  const pr = await githubJson<GhPull>(`/repos/${repo}/pulls/${prNumber}`);
  let closed_by: string | null = null;
  if (!pr.merged) {
    const issue = await githubJson<GhIssue>(`/repos/${repo}/issues/${prNumber}`);
    closed_by = issue.closed_by?.login ?? null;
  }
  return {
    number: pr.number,
    title: pr.title,
    merged: pr.merged,
    state: pr.state,
    merged_at: pr.merged_at,
    closed_at: pr.closed_at,
    html_url: pr.html_url,
    body: pr.body,
    closed_by
  };
}

async function resolveAuthor(explicit?: string): Promise<string> {
  if (explicit && explicit !== '@me' && explicit !== 'me') {
    return explicit.replace(/^@/, '');
  }
  const user = await githubJson<{ login: string }>('/user');
  return user.login;
}

export async function reconcileOutcomes(input: {
  dry_run?: boolean;
  repo?: string;
  issue_number?: number;
  author?: string;
  fetchPr?: (repo: string, prNumber: number) => Promise<PrTerminalSnapshot>;
}): Promise<ReconcileReport> {
  const dry_run = input.dry_run !== false;
  const debt = await findTrackODebt({ repo: input.repo, issue_number: input.issue_number });
  const fetchPr = input.fetchPr ?? fetchPrTerminalSnapshot;

  let author: string | null = null;
  try {
    author = await resolveAuthor(input.author);
  } catch (error) {
    return {
      dry_run,
      author: null,
      debt_count: debt.count,
      wrote: 0,
      skipped: 0,
      needs_adjudication: 0,
      items: debt.rows.map((row) => ({
        repo: row.repo,
        issue_number: row.issue_number,
        decision_id: row.decision_id,
        run_id: row.run_id,
        pr_url: row.pr_url,
        status: 'error',
        note: `failed to resolve author: ${error instanceof Error ? error.message : String(error)}`
      }))
    };
  }

  const items: ReconcileItem[] = [];
  let wrote = 0;
  let skipped = 0;
  let needs_adjudication = 0;

  for (const row of debt.rows) {
    const base = {
      repo: row.repo,
      issue_number: row.issue_number,
      decision_id: row.decision_id,
      run_id: row.run_id,
      pr_url: row.pr_url
    };

    // Idempotency: re-check terminals in case of concurrent writes.
    const latest = await listOutcomes({ repo: row.repo, issue_number: row.issue_number, limit: 50 });
    if (hasTerminalOutcome(latest)) {
      skipped += 1;
      items.push({ ...base, status: 'skipped_terminal', note: 'terminal outcome already present' });
      continue;
    }

    if (!row.pr_url) {
      skipped += 1;
      items.push({
        ...base,
        status: 'missing_pr_url',
        note: 'open-lane debt without pr_url; record pr_opened --pr-url first'
      });
      continue;
    }

    const parsed = parsePrUrl(row.pr_url);
    if (!parsed) {
      skipped += 1;
      items.push({ ...base, status: 'error', note: `unparseable pr_url: ${row.pr_url}` });
      continue;
    }

    let snapshot: PrTerminalSnapshot;
    try {
      snapshot = await fetchPr(parsed.repo, parsed.number);
    } catch (error) {
      skipped += 1;
      items.push({
        ...base,
        status: 'error',
        note: `GitHub fetch failed: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }

    const classified = classifyPrTerminal(snapshot, author);
    if (classified.action === 'open') {
      skipped += 1;
      items.push({ ...base, status: 'still_open', note: classified.note });
      continue;
    }

    if (classified.action === 'needs_adjudication') {
      needs_adjudication += 1;
      items.push({
        ...base,
        status: 'needs_adjudication',
        note: classified.note
      });
      continue;
    }

    if (dry_run) {
      wrote += 1;
      items.push({
        ...base,
        status: 'dry_run',
        proposed_event: classified.event,
        close_reason: classified.close_reason,
        note: classified.note
      });
      continue;
    }

    try {
      const event = await recordOutcome({
        repo: row.repo,
        issue_number: row.issue_number,
        event: classified.event,
        decision_id: row.decision_id,
        run_id: row.run_id,
        close_reason: classified.close_reason,
        pr_url: row.pr_url,
        notes: classified.note,
        source: 'outcome_reconcile',
        occurred_at: classified.occurred_at,
        data: {
          title: snapshot.title,
          reconciled_at: new Date().toISOString(),
          pr_number: snapshot.number
        }
      });
      wrote += 1;
      items.push({
        ...base,
        status: 'wrote',
        proposed_event: classified.event,
        close_reason: classified.close_reason,
        note: classified.note,
        event_id: event.event_id
      });
    } catch (error) {
      skipped += 1;
      items.push({
        ...base,
        status: 'error',
        note: `write failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  return {
    dry_run,
    author,
    debt_count: debt.count,
    wrote,
    skipped,
    needs_adjudication,
    items
  };
}
