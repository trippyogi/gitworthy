/**
 * Local watch registry (GW-048). No GitHub writes. No automatic creation from WATCH routes.
 */

import { randomUUID } from 'node:crypto';
import { githubJson } from '../lib/github.js';
import { stateFingerprint } from '../lib/state-fingerprint.js';
import { getWatchRecord, listWatchRecords, putWatchRecord, removeWatchRecord } from '../lib/watch-store.js';
import { GitworthyError, createEnvelope, type Envelope } from './envelope.js';
import { linked_work } from './linked-work.js';
import type { OpportunityTarget } from '../contracts/opportunities.js';
import {
  WatchRecordSchema,
  type WatchRecord,
  type WatchRecheck,
  type WatchSnapshot,
  type WatchTrigger
} from '../contracts/watch.js';

type GithubIssue = {
  state?: string;
  updated_at?: string;
  assignees?: Array<{ login?: string }>;
  pull_request?: unknown;
};

type GithubPull = {
  number: number;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  updated_at?: string;
};

export type WatchAddInput = {
  repo: string;
  issue_number?: number;
  pr_number?: number;
  note?: string;
};

function targetFromInput(input: WatchAddInput): OpportunityTarget {
  if (input.issue_number && input.pr_number) {
    throw new GitworthyError({
      code: 'watch_invalid_input',
      message: 'watch add requires issue_number or pr_number, not both.',
      not_checked: ['watch add requires exactly one target kind.']
    });
  }
  if (input.issue_number) {
    return { kind: 'issue', repo: input.repo, issue_number: input.issue_number };
  }
  if (input.pr_number) {
    return { kind: 'pull_request', repo: input.repo, pr_number: input.pr_number };
  }
  throw new GitworthyError({
    code: 'watch_invalid_input',
    message: 'watch add requires issue_number or pr_number.',
    not_checked: ['watch add requires a target.']
  });
}

export async function snapshotTarget(target: OpportunityTarget): Promise<{ snapshot: WatchSnapshot; fingerprint: string }> {
  if (target.kind === 'eval_anomaly') {
    throw new GitworthyError({
      code: 'watch_unsupported_target',
      message: 'eval_anomaly watch is not supported in this slice.',
      not_checked: ['eval_anomaly watch is deferred.']
    });
  }
  if (target.kind === 'issue') {
    const issue = await githubJson<GithubIssue>(`/repos/${target.repo}/issues/${target.issue_number}`);
    const linked = await linked_work({ repo: target.repo, issue_number: target.issue_number });
    const linked_prs = (linked.evidence as Array<{
      kind?: string;
      number?: number;
      state?: string;
      draft?: boolean;
      merged?: boolean;
      updated_at?: string;
    }>).filter((item) => item.kind === 'linked_pr' && typeof item.number === 'number')
      .map((item) => ({
        number: item.number!,
        state: item.state ?? 'open',
        draft: item.draft === true,
        merged: item.merged === true,
        updated_at: item.updated_at
      }));
    const snapshot: WatchSnapshot = {
      issue_state: issue.state,
      issue_updated_at: issue.updated_at,
      assignees: (issue.assignees ?? []).map((row) => row.login ?? '').filter(Boolean),
      linked_prs
    };
    return {
      snapshot,
      fingerprint: stateFingerprint({
        repo: target.repo,
        issue_number: target.issue_number,
        issue_state: snapshot.issue_state,
        issue_updated_at: snapshot.issue_updated_at,
        assignees: snapshot.assignees,
        linked_prs
      })
    };
  }
  const pr = await githubJson<GithubPull>(`/repos/${target.repo}/pulls/${target.pr_number}`);
  const snapshot: WatchSnapshot = {
    issue_state: pr.state,
    issue_updated_at: pr.updated_at,
    assignees: [],
    linked_prs: [{
      number: pr.number,
      state: pr.state ?? 'open',
      draft: pr.draft === true,
      merged: Boolean(pr.merged_at),
      updated_at: pr.updated_at
    }]
  };
  return {
    snapshot,
    fingerprint: stateFingerprint({
      repo: target.repo,
      issue_number: target.pr_number,
      issue_state: snapshot.issue_state,
      issue_updated_at: snapshot.issue_updated_at,
      linked_prs: snapshot.linked_prs
    })
  };
}

function diffSnapshots(before: WatchSnapshot, after: WatchSnapshot): { deltas: WatchRecheck['deltas']; triggers: WatchTrigger[] } {
  const deltas: WatchRecheck['deltas'] = [];
  const triggers: WatchTrigger[] = [];
  if (before.issue_state !== after.issue_state) {
    deltas.push({ path: 'issue_state', before: before.issue_state, after: after.issue_state });
    triggers.push('target_state_changed');
  }
  if (before.issue_updated_at !== after.issue_updated_at) {
    deltas.push({ path: 'issue_updated_at', before: before.issue_updated_at, after: after.issue_updated_at });
    if (!triggers.includes('target_state_changed')) triggers.push('target_state_changed');
  }
  const beforePrs = new Set(before.linked_prs.map((pr) => pr.number));
  const afterPrs = new Set(after.linked_prs.map((pr) => pr.number));
  for (const number of afterPrs) {
    if (!beforePrs.has(number)) {
      deltas.push({ path: `linked_prs.${number}`, before: null, after: number });
      triggers.push('new_pr');
    }
  }
  for (const pr of after.linked_prs) {
    const prior = before.linked_prs.find((row) => row.number === pr.number);
    if (prior && (prior.state !== pr.state || prior.merged !== pr.merged || prior.draft !== pr.draft)) {
      deltas.push({ path: `linked_prs.${pr.number}.state`, before: prior, after: pr });
      triggers.push('pr_state_changed');
    }
  }
  if (before.ci_state !== after.ci_state && (before.ci_state || after.ci_state)) {
    deltas.push({ path: 'ci_state', before: before.ci_state, after: after.ci_state });
    triggers.push('ci_changed');
  }
  if (before.maintainer_activity_at !== after.maintainer_activity_at && after.maintainer_activity_at) {
    deltas.push({ path: 'maintainer_activity_at', before: before.maintainer_activity_at, after: after.maintainer_activity_at });
    triggers.push('maintainer_activity');
  }
  return { deltas, triggers: [...new Set(triggers)] };
}

export async function watch_add(input: WatchAddInput): Promise<Envelope & { watch: WatchRecord }> {
  const target = targetFromInput(input);
  const { snapshot, fingerprint } = await snapshotTarget(target);
  const now = new Date().toISOString();
  const watch = WatchRecordSchema.parse({
    watch_version: 1,
    watch_id: `watch_${randomUUID()}`,
    target,
    created_at: now,
    updated_at: now,
    last_fingerprint: fingerprint,
    last_snapshot: snapshot,
    ...(input.note ? { note: input.note } : {})
  });
  await putWatchRecord(watch);
  return {
    ...createEnvelope({
      verdict_summary: `watching ${target.kind} locally; no GitHub write occurred.`,
      evidence: [{ kind: 'watch', watch_id: watch.watch_id, url: undefined }],
      checked: ['wrote local watch record'],
      not_checked: ['Watch is local-only. Routing never auto-creates watches.']
    }),
    watch
  };
}

export async function watch_list(): Promise<Envelope & { watches: WatchRecord[] }> {
  const watches = await listWatchRecords();
  return {
    ...createEnvelope({
      verdict_summary: watches.length === 0 ? 'no local watches.' : `${watches.length} local watches.`,
      evidence: watches.map((watch) => ({ kind: 'watch', watch_id: watch.watch_id })),
      checked: ['listed local watch registry'],
      not_checked: ['Watch list does not call GitHub.']
    }),
    watches
  };
}

export async function watch_show(watchId: string): Promise<Envelope & { watch: WatchRecord }> {
  const watch = await getWatchRecord(watchId);
  if (!watch) {
    throw new GitworthyError({
      code: 'watch_not_found',
      message: `watch ${watchId} was not found.`,
      not_checked: ['Watch show is local-only.']
    });
  }
  return {
    ...createEnvelope({
      verdict_summary: `local watch ${watchId}.`,
      evidence: [{ kind: 'watch', watch_id: watchId }],
      checked: ['read local watch record'],
      not_checked: ['Show does not recheck GitHub unless you run watch recheck.']
    }),
    watch
  };
}

export async function watch_recheck(input: {
  watch_id: string;
  write?: boolean;
}): Promise<Envelope & { recheck: WatchRecheck; watch: WatchRecord }> {
  const existing = await getWatchRecord(input.watch_id);
  if (!existing) {
    throw new GitworthyError({
      code: 'watch_not_found',
      message: `watch ${input.watch_id} was not found.`,
      not_checked: ['Recheck needs a local watch record.']
    });
  }
  const { snapshot, fingerprint } = await snapshotTarget(existing.target);
  const { deltas, triggers } = diffSnapshots(existing.last_snapshot, snapshot);
  const changed = fingerprint !== existing.last_fingerprint || deltas.length > 0;
  const shouldWrite = input.write !== false;
  let watch = existing;
  if (changed && shouldWrite) {
    watch = await putWatchRecord({
      ...existing,
      updated_at: new Date().toISOString(),
      last_fingerprint: fingerprint,
      last_snapshot: snapshot
    });
  }
  const recheck: WatchRecheck = {
    watch_id: existing.watch_id,
    changed,
    triggers: changed ? (triggers.length > 0 ? triggers : ['manual']) : [],
    deltas,
    fingerprint_before: existing.last_fingerprint,
    fingerprint_after: fingerprint,
    updated: changed && shouldWrite
  };
  return {
    ...createEnvelope({
      verdict_summary: changed
        ? `watch ${existing.watch_id} changed (${recheck.triggers.join(', ') || 'manual'}).`
        : `watch ${existing.watch_id} unchanged.`,
      evidence: [{ kind: 'watch_recheck', watch_id: existing.watch_id, changed }],
      checked: ['compared fingerprint and snapshot fields'],
      not_checked: ['Watch recheck never writes to GitHub.']
    }),
    recheck,
    watch
  };
}

export async function watch_remove(watchId: string): Promise<Envelope & { removed: boolean }> {
  const removed = await removeWatchRecord(watchId);
  if (!removed) {
    throw new GitworthyError({
      code: 'watch_not_found',
      message: `watch ${watchId} was not found.`,
      not_checked: ['Remove is local-only.']
    });
  }
  return {
    ...createEnvelope({
      verdict_summary: `removed local watch ${watchId}.`,
      evidence: [{ kind: 'watch_removed', watch_id: watchId }],
      checked: ['deleted local watch record'],
      not_checked: ['No GitHub mutation.']
    }),
    removed: true
  };
}

export async function listLocalWatches(): Promise<WatchRecord[]> {
  return listWatchRecords();
}
