/** MCP tool metadata: descriptions, annotations, and onboarding roles (GW-032). */

export type ToolRole = 'primary' | 'evidence' | 'config' | 'store' | 'admin';

export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ToolMeta = {
  title: string;
  description: string;
  role: ToolRole;
  annotations: ToolAnnotations;
};

const readGithub: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true
};

const readLocal: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false
};

const writeLocal: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

const mutateLocal: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
};

/**
 * Primary onboarding tools hosts should prefer first.
 * Evidence tools dig into provider signals; store/admin mutate local data only.
 */
export const TOOL_META = {
  doctor: {
    title: 'Doctor',
    role: 'primary',
    description:
      'Diagnose whether Gitworthy can run safely: Node/git, token/auth, rate limit, timeline capability, npm, cache, and local data store. Returns a versioned capability matrix with remediations. Prefer before hunt/check. Optional full=true enables safe ls-remote. Read-only aside from ephemeral probe files.',
    annotations: { ...readGithub, title: 'Doctor' }
  },
  worth_check: {
    title: 'Worth check',
    role: 'primary',
    description:
      'Primary pre-flight for a single issue (owner/repo + issue_number). Returns ACT/VERIFY/SKIP with disposition, findings, and next actions. Uses GitHub (and optional npm probe). Budget: typically a handful of GitHub requests; no full clone for evidence. Persists a local run/decision; optional capture writes a local capture only — never mutates GitHub.',
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true, title: 'Worth check' }
  },
  hunt: {
    title: 'Hunt',
    role: 'primary',
    description:
      'Discover and preflight issue candidates in a repo or org. Bounded max_checks (default ~3); resumes via resume_run_id. Prefer over raw scan when you need ACT/VERIFY/SKIP verdicts. Use portfolio for contribution-mode ranking across issues and PRs. Cost scales with max_repos × pages × checks. Persists local run progress; optional capture is local-only — never mutates GitHub.',
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true, title: 'Hunt' }
  },
  portfolio: {
    title: 'Portfolio',
    role: 'primary',
    description:
      'Rank contribution opportunities (issues + PRs) by mode: BUILD/REVIEW/SALVAGE/REPRODUCE/EVAL/DOC/WATCH/PASS. Dispatch state is separate from primary_mode and from ACT/VERIFY/SKIP. Hunt remains issue scouting; portfolio is the broader routing surface. Never mutates GitHub. Capacity comes from local outcomes. WIP full queues BUILD without rewriting the mode.',
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true, title: 'Portfolio' }
  },
  brief: {
    title: 'Brief',
    role: 'primary',
    description:
      'Render an actionable brief for a stored decision_id (human/agent summary of verdict, evidence, next steps). Local store read; no GitHub writes.',
    annotations: { ...readLocal, title: 'Brief' }
  },
  brief_show: {
    title: 'Show brief',
    role: 'primary',
    description:
      'Alias of brief: show a stored decision brief by decision_id. Prefer brief going forward.',
    annotations: { ...readLocal, title: 'Show brief' }
  },
  store_outcome_record: {
    title: 'Record outcome',
    role: 'primary',
    description:
      'Record a local outcome event (selected/pr_opened/merged/closed_unmerged/etc.) for a target. For closed_unmerged pass close_reason (superseded|stale|withdrawn). Set acted_against_skip when contributing against a soft SKIP (Track O). Writes only to the local store — never mutates GitHub. On execute lane: record selected when claiming, then pr_opened with pr_url when the PR exists. Terminals: prefer store_outcome_reconcile after merges/closes.',
    annotations: { ...writeLocal, title: 'Record outcome' }
  },
  store_outcome_reconcile: {
    title: 'Reconcile outcomes',
    role: 'primary',
    description:
      'Close Track O loops: scan local pr_opened / selected+pr_url debt without a terminal, fetch GitHub PR state, and propose or write clear terminals (merged; author-withdrawn). Ambiguous maintainer closes go to needs_adjudication — never auto-superseded/rejected. Default dry_run=true; set write=true to persist. Does not promote to eval/frozen/.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      title: 'Reconcile outcomes'
    }
  },
  store_outcome_backfill: {
    title: 'Backfill outcomes',
    role: 'primary',
    description:
      'Phase 2 reconstructed backfill; dry_run default; write=true to persist; never mix into snapshot-backed metrics.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      title: 'Backfill outcomes'
    }
  },
  scan: {
    title: 'Scan issues',
    role: 'evidence',
    description:
      'Evidence/debug: list ranked open issues for one repo without full worth_check preflights. Prefer hunt for verdicts. Bounded by limit and max_pages.',
    annotations: { ...readGithub, title: 'Scan issues' }
  },
  pr_scan: {
    title: 'PR scan',
    role: 'evidence',
    description:
      'Bounded two-stage pull-request inventory (max 25) with enrichment of the top 5. Filters bots and merged PRs. Used by portfolio for REVIEW/WATCH/SALVAGE. Read-only GitHub; no automatic review comments.',
    annotations: { ...readGithub, title: 'PR scan' }
  },
  org_scan: {
    title: 'Org scan',
    role: 'evidence',
    description:
      'Evidence/debug: multi-repo discovery across an org/user. Prefer hunt for preflighted decisions. Bounded by max_repos and pages.',
    annotations: { ...readGithub, title: 'Org scan' }
  },
  branch_scan: {
    title: 'Branch scan',
    role: 'evidence',
    description:
      'Evidence/debug: find remote branches matching keywords (possible in-flight work). Read-only GitHub/git metadata.',
    annotations: { ...readGithub, title: 'Branch scan' }
  },
  issue_vs_main: {
    title: 'Issue versus main',
    role: 'evidence',
    description:
      'Evidence/debug: check whether main already contains work matching the issue. Uses bounded git object inspection, not a full working-tree checkout.',
    annotations: { ...readGithub, title: 'Issue versus main' }
  },
  release_gap: {
    title: 'Release gap',
    role: 'evidence',
    description:
      'Evidence/debug: compare repo tip vs published npm package for an unreleased fix. Needs npm_package name.',
    annotations: { ...readGithub, title: 'Release gap' }
  },
  dupe_cluster: {
    title: 'Duplicate cluster',
    role: 'evidence',
    description:
      'Evidence/debug: find likely duplicate issues near a target. Heuristic; not a verdict.',
    annotations: { ...readGithub, title: 'Duplicate cluster' }
  },
  related_cluster: {
    title: 'Related cluster',
    role: 'evidence',
    description:
      'Evidence/debug: related open issues by keywords/labels. Heuristic ranking.',
    annotations: { ...readGithub, title: 'Related cluster' }
  },
  linked_work: {
    title: 'Linked work',
    role: 'evidence',
    description:
      'Evidence/debug: PRs and timeline cross-references linked to an issue. Requires timeline-capable token for cross-referenced events.',
    annotations: { ...readGithub, title: 'Linked work' }
  },
  contention: {
    title: 'Contention analysis',
    role: 'evidence',
    description:
      'Evidence/debug: in-flight PR overlap / swarm risk for an issue. Heavier than linked_work; bounded by budget_bytes.',
    annotations: { ...readGithub, title: 'Contention analysis' }
  },
  scope_check: {
    title: 'Scope check',
    role: 'evidence',
    description:
      'Evidence/debug: compare a local or provided diff against the issue scope. Local filesystem + GitHub metadata.',
    annotations: { ...readGithub, title: 'Scope check' }
  },
  contrib_policy: {
    title: 'Contribution policy',
    role: 'evidence',
    description:
      'Evidence/debug: extract contribution/CLA/claim norms from repo docs. Read-only.',
    annotations: { ...readGithub, title: 'Contribution policy' }
  },
  list_probe_templates: {
    title: 'List probe templates',
    role: 'evidence',
    description:
      'List built-in release-gap probe templates. Local/static; no network.',
    annotations: { ...readLocal, title: 'List probe templates' }
  },
  config_validate: {
    title: 'Validate config',
    role: 'config',
    description:
      'Validate user/repo config and target manifests. Local files only; tokens are never read from config.',
    annotations: { ...readLocal, title: 'Validate config' }
  },
  config_show: {
    title: 'Show effective config',
    role: 'config',
    description:
      'Show resolved effective config values and provenance. Redacts unsafe fields.',
    annotations: { ...readLocal, title: 'Show effective config' }
  },
  profile_show: {
    title: 'Show skill profile',
    role: 'config',
    description:
      'Show the effective skill/profile used for ranking. Local config read.',
    annotations: { ...readLocal, title: 'Show skill profile' }
  },
  ledger_lookup: {
    title: 'Ledger lookup',
    role: 'store',
    description:
      'Look up a legacy/local ledger entry for a target. Local store read.',
    annotations: { ...readLocal, title: 'Ledger lookup' }
  },
  ledger_list: {
    title: 'Ledger list',
    role: 'store',
    description:
      'List local ledger entries. Local store read.',
    annotations: { ...readLocal, title: 'Ledger list' }
  },
  ledger_record: {
    title: 'Ledger record',
    role: 'store',
    description:
      'Write a local ledger note for a target. Does not mutate GitHub.',
    annotations: { ...writeLocal, title: 'Ledger record' }
  },
  store_target_show: {
    title: 'Show store target',
    role: 'store',
    description:
      'Show indexed runs/decisions/outcomes for owner/repo#issue. Local store read.',
    annotations: { ...readLocal, title: 'Show store target' }
  },
  store_decision_list: {
    title: 'List store decisions',
    role: 'store',
    description:
      'List stored decisions, optionally filtered by repo/issue. Local store read.',
    annotations: { ...readLocal, title: 'List store decisions' }
  },
  store_recheck: {
    title: 'Recheck target',
    role: 'store',
    description:
      'Re-run worth_check for a stored target and persist results. Uses GitHub/npm; writes local store.',
    annotations: { ...readGithub, readOnlyHint: false, title: 'Recheck target' }
  },
  store_export: {
    title: 'Export store slice',
    role: 'store',
    description:
      'Export a local store slice to out_dir for debugging or eval promotion. Writes files under out_dir only.',
    annotations: { ...writeLocal, title: 'Export store slice' }
  },
  store_migrate_ledger: {
    title: 'Migrate legacy ledger',
    role: 'admin',
    description:
      'One-time migration of legacy ledger entries into the versioned store. Local mutate; safe to re-run (idempotent marker).',
    annotations: { ...mutateLocal, title: 'Migrate legacy ledger' }
  },
  store_rebuild_indexes: {
    title: 'Rebuild store indexes',
    role: 'admin',
    description:
      'Drop and rebuild per-target indexes from durable records. Local mutate; does not delete runs/decisions.',
    annotations: { ...mutateLocal, title: 'Rebuild store indexes' }
  },
  capture_show: {
    title: 'Show capture',
    role: 'admin',
    description:
      'Show a local capture manifest by capture_id.',
    annotations: { ...readLocal, title: 'Show capture' }
  },
  capture_list: {
    title: 'List captures',
    role: 'admin',
    description:
      'List local capture manifests.',
    annotations: { ...readLocal, title: 'List captures' }
  },
  watch_add: {
    title: 'Watch add',
    role: 'store',
    description:
      'Create a local-only watch record for an issue or PR. Never writes to GitHub and is never created automatically from a WATCH routing mode.',
    annotations: { ...writeLocal, title: 'Watch add' }
  },
  watch_list: {
    title: 'Watch list',
    role: 'store',
    description:
      'List local watch records. Local store read only; no GitHub calls.',
    annotations: { ...readLocal, title: 'Watch list' }
  },
  watch_show: {
    title: 'Watch show',
    role: 'store',
    description:
      'Show one local watch record. Local store read only.',
    annotations: { ...readLocal, title: 'Watch show' }
  },
  watch_recheck: {
    title: 'Watch recheck',
    role: 'store',
    description:
      'Fetch current target state, compare the stored fingerprint, and report exact field deltas. Updates the local record unless write=false. Never writes to GitHub.',
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true, title: 'Watch recheck' }
  },
  watch_remove: {
    title: 'Watch remove',
    role: 'store',
    description:
      'Delete a local watch record. Local-only; no GitHub mutation.',
    annotations: { ...mutateLocal, title: 'Watch remove' }
  },
  case_promote: {
    title: 'Promote capture',
    role: 'admin',
    description:
      'Promote a capture into a proposed eval case fixture file. Writes out_path; never publishes remotely.',
    annotations: { ...writeLocal, title: 'Promote capture' }
  }
} as const satisfies Record<string, ToolMeta>;

export type ToolName = keyof typeof TOOL_META;

export const PRIMARY_TOOL_NAMES = (Object.keys(TOOL_META) as ToolName[]).filter(
  (name) => TOOL_META[name].role === 'primary'
);

export function toolConfig<TInput>(name: ToolName, inputSchema: TInput) {
  const meta = TOOL_META[name];
  return {
    title: meta.title,
    description: meta.description,
    inputSchema,
    annotations: meta.annotations,
    _meta: {
      gitworthy_role: meta.role,
      gitworthy_primary: meta.role === 'primary'
    }
  };
}

export function listToolMetaSnapshot(): Array<{
  name: string;
  title: string;
  role: ToolRole;
  description: string;
  annotations: ToolAnnotations;
}> {
  return (Object.keys(TOOL_META) as ToolName[])
    .sort()
    .map((name) => ({
      name,
      title: TOOL_META[name].title,
      role: TOOL_META[name].role,
      description: TOOL_META[name].description,
      annotations: TOOL_META[name].annotations
    }));
}
