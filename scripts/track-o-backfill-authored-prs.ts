/**
 * Track O Phase 2: backfill reconstructed outcomes for authored third-party PRs.
 *
 * Usage:
 *   pnpm exec tsx scripts/track-o-backfill-authored-prs.ts [--dry-run]
 *
 * Writes to GITWORTHY_STORE_DIR (default ~/.gitworthy/store).
 * Excludes self-owned orgs (trippyogi, MetaTravelers). Open PRs are listed but not labeled.
 * Reconstructed rows must never mix into snapshot-backed headline metrics.
 */
import { execFileSync } from 'node:child_process';
import { putDecisionRecord, putOutcomeEvent, putRunRecord } from '../src/lib/store.js';
import { putTrackOCovariates } from '../src/lib/track-o-covariates.js';
import { newDecisionId, newRunId } from '../src/contracts/common.js';
import type { CloseReason } from '../src/contracts/outcomes.js';

const SELF_OWNERS = new Set(['trippyogi', 'MetaTravelers']);
const dryRun = process.argv.includes('--dry-run');

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

type Classified = {
  repo: string;
  number: number;
  title: string;
  url: string;
  event: 'merged' | 'rejected' | 'closed_unmerged' | 'drop';
  close_reason?: CloseReason;
  note: string;
};

function ghJson<T>(args: string[]): T {
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(raw) as T;
}

function classify(pr: GhPull, repo: string): Classified {
  const base = { repo, number: pr.number, title: pr.title, url: pr.html_url };
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
  if (pr.user?.login?.toLowerCase() === 'trippyogi') {
    if (/\b(maintainers? (rejected|declined)|wontfix|won't fix|not interested)\b/i.test(body)) {
      return { ...base, event: 'rejected', note: 'body explicitly indicates maintainer rejection' };
    }
    return {
      ...base,
      event: 'closed_unmerged',
      close_reason: 'withdrawn',
      note: 'closed unmerged; defaulting to withdrawn (author-owned close heuristic) — re-adjudicate if wrong'
    };
  }

  return { ...base, event: 'drop', note: 'closed unmerged but closer unclear; drop per Phase 2 rule' };
}

async function writeReconstructed(row: Classified): Promise<void> {
  if (row.event === 'drop') return;
  const decisionId = newDecisionId();
  const runId = newRunId();
  const at = new Date().toISOString();
  const target = {
    input_repo: row.repo,
    canonical_repo: row.repo,
    issue_number: row.number,
    issue_url: `https://github.com/${row.repo}/issues/${row.number}`
  };

  if (dryRun) {
    console.log('[dry-run]', row.event, row.close_reason ?? '', `${row.repo}#${row.number}`, row.note);
    return;
  }

  await putRunRecord({
    run_id: runId,
    command: 'track_o_reconstructed',
    generated_at: at,
    summary: `Track O reconstructed backfill for ${row.repo}#${row.number}`,
    target: { repo: row.repo, issue_number: row.number },
    decision_id: decisionId,
    checked: ['track_o_phase2_backfill'],
    not_checked: ['no live T0 snapshot; reconstructed partition only']
  });

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
    reconstructed: true,
    has_track_o_covariates: true
  });

  await putTrackOCovariates({
    decision_id: decisionId,
    run_id: runId,
    target: { repo: row.repo, issue_number: row.number },
    captured_at: at,
    reconstructed: true,
    covariates: {}
  });

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

  console.log('wrote', row.event, row.close_reason ?? '', `${row.repo}#${row.number}`);
}

async function main(): Promise<void> {
  const items = ghJson<SearchPr[]>([
    'search', 'prs', '--author', 'trippyogi', '--limit', '200',
    '--json', 'repository,number,title,state,url,closedAt'
  ]);

  const third = items.filter((it) => !SELF_OWNERS.has((it.repository.nameWithOwner || '').split('/')[0]!));
  const terminal = third.filter((it) => it.state === 'merged' || it.state === 'closed');
  const open = third.filter((it) => it.state === 'open');

  console.log(`inventory third_party=${third.length} terminal=${terminal.length} open_skipped=${open.length}`);
  console.log(`mode=${dryRun ? 'dry-run' : 'write'} store=${process.env.GITWORTHY_STORE_DIR ?? '~/.gitworthy/store'}`);

  const classified: Classified[] = [];
  for (const it of terminal) {
    const repo = it.repository.nameWithOwner;
    const pr = ghJson<GhPull>(['api', `repos/${repo}/pulls/${it.number}`]);
    classified.push(classify(pr, repo));
  }

  let wrote = 0;
  let dropped = 0;
  for (const row of classified) {
    if (row.event === 'drop') {
      dropped += 1;
      console.log('drop', `${row.repo}#${row.number}`, row.note);
      continue;
    }
    await writeReconstructed(row);
    wrote += 1;
  }

  console.log(`done wrote=${wrote} dropped=${dropped} open_pending=${open.length}`);
  console.log('partition=reconstructed (do not mix into snapshot-backed ACT precision)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
