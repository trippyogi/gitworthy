/**
 * Track O Phase 2: backfill reconstructed outcomes for authored third-party PRs.
 *
 * Excludes self-owned orgs (trippyogi, MetaTravelers). Open PRs are listed but not labeled.
 * Reconstructed rows must never mix into snapshot-backed headline metrics.
 */
import { execFileSync } from 'node:child_process';
import { getRunRecord, putDecisionRecord, putOutcomeEvent, putRunRecord } from './store.js';
import { getTrackOCovariates, putTrackOCovariates } from './track-o-covariates.js';
import { listDecisions, listOutcomes } from './store-query.js';
import { newDecisionId, newRunId } from '../contracts/common.js';
import type { CloseReason } from '../contracts/outcomes.js';
import type { DecisionRecord } from '../contracts/store.js';

const SELF_OWNERS = new Set(['trippyogi', 'metatravelers']);

export type TrackOBackfillReport = {
  author: string;
  dry_run: boolean;
  third_party_closed: number;
  terminal: number;
  open_pending: number;
  wrote: number;
  skipped: number;
  dropped: number;
};

type SearchPr = {
  repository: { nameWithOwner: string };
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  url: string;
};

type GhPull = {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  merged_at: string | null;
  closed_at: string | null;
  user: { login: string } | null;
  html_url: string;
  body: string | null;
  comments: number;
};

type GhIssue = {
  closed_by: { login: string } | null;
};

type Classified = {
  repo: string;
  number: number;
  title: string;
  url: string;
  event: 'merged' | 'rejected' | 'closed_unmerged' | 'drop';
  close_reason?: CloseReason;
  note: string;
  occurred_at: string;
};

function ownerLogin(nameWithOwner: string): string {
  return (nameWithOwner.split('/')[0] ?? '').toLowerCase();
}

function isSelfOwned(nameWithOwner: string, author: string): boolean {
  const owner = ownerLogin(nameWithOwner);
  return owner.length > 0 && (owner === author.toLowerCase() || SELF_OWNERS.has(owner));
}

function ghJson<T>(args: string[]): T {
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(raw) as T;
}

function resolveAuthor(raw: string): string {
  if (raw === '@me' || raw === 'me') {
    return ghJson<{ login: string }>(['api', 'user']).login;
  }
  return raw.replace(/^@/, '');
}

function classify(pr: GhPull, repo: string, author: string, closedBy: string | null): Classified {
  const base = {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    occurred_at: pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  };
  if (pr.merged) {
    return { ...base, event: 'merged', note: 'merged into default branch' };
  }

  // Known Track O narratives (human GT from product notes).
  if (repo === 'NousResearch/hermes-agent' && pr.number === 76802) {
    return {
      ...base,
      event: 'closed_unmerged',
      close_reason: 'superseded',
      note: 'superseded by #76800; scope broader than #76793 (product narrative)'
    };
  }

  const body = (pr.body ?? '').toLowerCase();
  if (/superseded by|already (fixed|landed|merged)|duplicate of #|closed in favor of|replaced by #/i.test(body)) {
    return { ...base, event: 'closed_unmerged', close_reason: 'superseded', note: 'body indicates supersession' };
  }

  // Author-closed without merge → withdrawn by default.
  // Do NOT treat code words like "reject duplicate ids" in the patch as maintainer rejection.
  if (closedBy && closedBy.toLowerCase() === author.toLowerCase()) {
    if (/\b(maintainers? (rejected|declined)|wontfix|won't fix|not interested)\b/i.test(body)) {
      return { ...base, event: 'rejected', note: 'body explicitly indicates maintainer rejection' };
    }
    return {
      ...base,
      event: 'closed_unmerged',
      close_reason: 'withdrawn',
      note: 'closed unmerged by author; defaulting to withdrawn — re-adjudicate if wrong'
    };
  }

  return {
    ...base,
    event: 'drop',
    note: `closed unmerged but closer=${closedBy ?? 'unknown'}; drop per Phase 2 rule`
  };
}

async function targetGate(repo: string, issueNumber: number): Promise<
  | { action: 'skip'; reason: 'outcome' | 'snapshot' }
  | { action: 'write'; resume?: DecisionRecord }
> {
  const outcomes = await listOutcomes({ repo, issue_number: issueNumber, limit: 20 });
  if (outcomes.length > 0) return { action: 'skip', reason: 'outcome' };

  const decisions = await listDecisions({ repo, issue_number: issueNumber, limit: 50 });
  const snapshot = decisions.find((d) => d.reconstructed !== true);
  if (snapshot) return { action: 'skip', reason: 'snapshot' };

  const reconstructed = decisions.find((d) => d.reconstructed === true);
  return { action: 'write', resume: reconstructed };
}

async function writeReconstructed(
  row: Classified,
  author: string,
  dryRun: boolean,
  log: (line: string) => void
): Promise<'wrote' | 'skipped' | 'dry-run'> {
  if (row.event === 'drop') return 'skipped';
  if (isSelfOwned(row.repo, author)) {
    log(`skip self-owned ${row.repo}#${row.number}`);
    return 'skipped';
  }

  const gate = await targetGate(row.repo, row.number);
  if (gate.action === 'skip') {
    log(`skip existing ${gate.reason} ${row.repo}#${row.number}`);
    return 'skipped';
  }

  if (dryRun) {
    log(`[dry-run] ${row.event} ${row.close_reason ?? ''} ${row.repo}#${row.number} ${row.note}`.replace(/\s+/g, ' ').trim());
    return 'dry-run';
  }

  const decisionId = gate.resume?.decision_id ?? newDecisionId();
  const runId = gate.resume?.run_id ?? newRunId();
  const at = row.occurred_at;
  const target = {
    input_repo: row.repo,
    canonical_repo: row.repo,
    issue_number: row.number,
    issue_url: `https://github.com/${row.repo}/issues/${row.number}`
  };

  if (!gate.resume) {
    // Decision first so a mid-write failure never leaves a run pointing at a missing decision.
    await putDecisionRecord({
      decision_id: decisionId,
      run_id: runId,
      created_at: at,
      target,
      // Placeholder verdict — excluded from snapshot-backed ACT precision by reconstructed=true.
      verdict: 'VERIFY',
      disposition: 'review',
      reasons: ['track_o_reconstructed_no_t0_verdict', row.note],
      signals: [],
      findings: [],
      next_actions: [],
      reconstructed: true,
      has_track_o_covariates: true
    });
  }

  // Always ensure run + covariates exist (covers resume after partial failure).
  if (!(await getRunRecord(runId))) {
    await putRunRecord({
      run_id: runId,
      command: 'track_o_reconstructed',
      generated_at: at,
      cached: false,
      summary: `Track O reconstructed backfill for ${row.repo}#${row.number}`,
      target: { repo: row.repo, issue_number: row.number },
      decision_id: decisionId,
      checked: ['track_o_phase2_backfill'],
      not_checked: ['no live T0 snapshot; reconstructed partition only'],
      metrics: {}
    });
  }

  if (!(await getTrackOCovariates(decisionId))) {
    await putTrackOCovariates({
      decision_id: decisionId,
      run_id: runId,
      target: { repo: row.repo, issue_number: row.number },
      captured_at: at,
      reconstructed: true,
      covariates: {}
    });
  }

  await putOutcomeEvent({
    decision_id: decisionId,
    run_id: runId,
    target: { repo: row.repo.toLowerCase(), issue_number: row.number },
    event: row.event,
    close_reason: row.close_reason,
    pr_url: row.url,
    occurred_at: at,
    source: 'track_o_phase2_backfill',
    notes: row.note,
    data: { title: row.title, reconstructed: true }
  });

  log(`${gate.resume ? 'resumed' : 'wrote'} ${row.event} ${row.close_reason ?? ''} ${row.repo}#${row.number}`.replace(/\s+/g, ' ').trim());
  return 'wrote';
}

/**
 * Phase 2 reconstructed backfill for authored third-party PRs.
 * Default dry-run; pass write=true to persist. Never mix into snapshot-backed metrics.
 */
export async function runTrackOBackfill(input: {
  author?: string;
  write?: boolean;
  log?: (line: string) => void;
} = {}): Promise<TrackOBackfillReport> {
  const log = input.log ?? ((line: string) => {
    process.stderr.write(`${line}\n`);
  });
  const dryRun = input.write !== true;
  const author = resolveAuthor(input.author ?? '@me');

  // Ask gh to exclude self-owned orgs from the search quota (best-effort; still filter locally).
  const searchExtras = [...new Set([...SELF_OWNERS, author.toLowerCase()])].map((o) => `-org:${o}`);
  const items = ghJson<SearchPr[]>([
    'search', 'prs', '--author', author, '--state', 'closed', '--limit', '200',
    '--json', 'repository,number,title,state,url,closedAt',
    '--', ...searchExtras
  ]);
  const openHits = ghJson<SearchPr[]>([
    'search', 'prs', '--author', author, '--state', 'open', '--limit', '100',
    '--json', 'repository,number,title,state,url',
    '--', ...searchExtras
  ]);

  const third = items.filter((it) => !isSelfOwned(it.repository.nameWithOwner || '', author));
  const terminal = third.filter((it) => it.state === 'merged' || it.state === 'closed');
  const open = openHits.filter((it) => !isSelfOwned(it.repository.nameWithOwner || '', author));
  const leaked = items.filter((it) => isSelfOwned(it.repository.nameWithOwner || '', author));

  if (items.length >= 200 && leaked.length > 0) {
    log(
      `warn: closed-PR search hit the 200 cap with ${leaked.length} self-owned rows still present; third-party inventory may be incomplete`
    );
  } else if (items.length >= 200) {
    log('warn: gh closed-PR search returned 200 hits (limit); inventory may be truncated');
  }
  if (leaked.length > 0) {
    log(`warn: search returned ${leaked.length} self-owned hit(s); dropping them locally`);
  }
  log(`author=${author} inventory third_party_closed=${third.length} terminal=${terminal.length} open_skipped=${open.length}`);
  log(`mode=${dryRun ? 'dry-run' : 'write'} store=${process.env.GITWORTHY_STORE_DIR ?? '~/.gitworthy/store'}`);

  const classified: Classified[] = [];
  for (const it of terminal) {
    const repo = it.repository.nameWithOwner;
    const pr = ghJson<GhPull>(['api', `repos/${repo}/pulls/${it.number}`]);
    const issue = pr.merged
      ? { closed_by: null }
      : ghJson<GhIssue>(['api', `repos/${repo}/issues/${it.number}`]);
    classified.push(classify(pr, repo, author, issue.closed_by?.login ?? null));
  }

  let wrote = 0;
  let dropped = 0;
  let skipped = 0;
  for (const row of classified) {
    if (row.event === 'drop') {
      dropped += 1;
      log(`drop ${row.repo}#${row.number} ${row.note}`);
      continue;
    }
    const result = await writeReconstructed(row, author, dryRun, log);
    if (result === 'wrote' || result === 'dry-run') wrote += 1;
    else skipped += 1;
  }

  log(`done wrote=${wrote} skipped=${skipped} dropped=${dropped} open_pending=${open.length}`);
  log('partition=reconstructed (do not mix into snapshot-backed ACT precision)');

  return {
    author,
    dry_run: dryRun,
    third_party_closed: third.length,
    terminal: terminal.length,
    open_pending: open.length,
    wrote,
    skipped,
    dropped
  };
}
