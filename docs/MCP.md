# MCP contract (GW-032)

Gitworthy’s primary agent surface is MCP (`gitworthy mcp` / HTTP). Hosts should prefer structured results over prose.

Host setup (Cursor / ChatGPT / Hermes / HTTP): see the README MCP section and [`HTTP_MCP.md`](./HTTP_MCP.md).

## Primary onboarding tools

| Tool | Role |
|---|---|
| `doctor` | Capability matrix before other work |
| `worth_check` | Single-issue ACT/VERIFY/SKIP |
| `hunt` | Bounded issue discovery + preflight (`resume_run_id` for partials) |
| `portfolio` | Rank issues + PRs by contribution mode; dispatch is separate from verdict |
| `ci_triage` | Classify caller-supplied CI conclusions (never `stale_fixture`) |
| `history_scan` | Bounded git history for caller-supplied paths/symbols/terms |
| `opportunity_ingest` | Accept an external eval anomaly as an EVAL opportunity |
| `brief` / `brief_show` | Decision brief from local store |
| `store_outcome_record` | Local outcome feedback loop (`selected` / `pr_opened` / terminals) |
| `store_outcome_reconcile` | Close Track O debt against GitHub PR state (dry-run by default) |
| `store_outcome_backfill` | Phase 2 reconstructed personal-history backfill (dry-run by default) |

Evidence tools support investigation; they are not substitutes for `worth_check` / `hunt` verdicts.

## Tool catalog (roles)

| Role | Tools |
|---|---|
| primary | `doctor`, `worth_check`, `hunt`, `portfolio`, `brief`, `brief_show`, `store_outcome_record`, `store_outcome_reconcile`, `store_outcome_backfill` |
| evidence | `scan`, `org_scan`, `pr_scan`, `ci_triage`, `history_scan`, `opportunity_ingest`, `branch_scan`, `issue_vs_main`, `release_gap`, `dupe_cluster`, `related_cluster`, `linked_work`, `contention`, `scope_check`, `contrib_policy`, `list_probe_templates` |
| config | `config_validate`, `config_show`, `profile_show` |
| store | `ledger_*`, `watch_*`, `store_target_show`, `store_decision_list`, `store_recheck`, `store_export` |
| admin | `store_migrate_ledger`, `store_rebuild_indexes`, `capture_*`, `case_promote` |

Each registration includes a long description, MCP annotations, and `_meta.gitworthy_role` (see `src/mcp/tool-meta.ts`).

## Annotations

- `readOnlyHint` — no local store writes and no GitHub writes; tools that persist runs/decisions set this false even when GitHub stays read-only
- `idempotentHint` — safe to retry with the same args
- `openWorldHint` — may call GitHub/npm/network
- `destructiveHint` — local admin mutate (migrate/rebuild)

Hints are advisory. Input validation uses shared CLI contracts (`src/contracts/inputs.ts`).

## Results

1. `content[0].text` — pretty-printed JSON (compatibility)
2. `structuredContent` — the same object for hosts that consume structured results
3. `isError: true` for operational/input failures (with `ErrorResult` body)

Do not parse human CLI output in agents. Verdict semantics: [`VERDICTS.md`](./VERDICTS.md).

## Stdio

Diagnostics must not write to stdout on the stdio transport. Use stderr for human progress when running the CLI; MCP stdio keeps stdout for protocol frames only.

## Self-test

```bash
pnpm mcp:self-test
```

Lists tools in-process and checks primary tools have descriptions + annotations.
