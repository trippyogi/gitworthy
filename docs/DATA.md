# Local data store

Gitworthy persists runs, decisions, outcomes, indexes, and captures under the local store (default `~/.gitworthy/store`, override with `GITWORTHY_STORE_DIR`).

Nothing here is uploaded. Captures marked local-only must stay on the machine that created them.

## Layout (conceptual)

| Area | Contents |
|---|---|
| `runs/` | Durable hunt/check run records |
| `decisions/` | Versioned verdict decisions (**Track O T0 verdict-inputs snapshot**) |
| `outcomes/` | Local outcome events (`selected`, `pr_opened`, `merged`, `closed_unmerged`, …) |
| `track-o/covariates/` | Optional Track O analysis covariates (never read by the verdict path) |
| `indexes/targets/` | Per-target indexes (rebuildable) |
| `migrations/` | Migration markers |
| ledger quarantine | Malformed legacy blobs (never treated as empty success) |

Schemas: `schemas/gitworthy-run-record.v1.schema.json`, `gitworthy-decision-record.v1.schema.json`, `gitworthy-outcome-event.v1.schema.json`, `gitworthy-target-index.v1.schema.json`, `gitworthy-capture-manifest.v1.schema.json`, plus Track O schemas (`gitworthy-track-o-*.v1.schema.json`). See [`TRACK_O.md`](./TRACK_O.md).

## Common commands

```sh
gitworthy store target owner/repo#123 --json
gitworthy decision list [--repo owner/repo] [--json]
gitworthy outcome record owner/repo#123 --event selected --decision-id … --json
gitworthy outcome record owner/repo#123 --event closed_unmerged --close-reason superseded [--acted-against-skip] [--pr-url url] --json
gitworthy store rebuild-indexes --json
gitworthy ledger migrate [--force] --json
gitworthy store export --out-dir ./export --json
gitworthy capture list --json
gitworthy recheck owner/repo#123 --json
```

## Migrations and rebuilds

- `ledger migrate` lifts legacy ledger entries into the versioned store (idempotent marker; `--force` re-runs).
- `store rebuild-indexes` rebuilds indexes from durable records; it does not delete runs/decisions.
- Doctor’s `data_store` capability warns on stale locks / quarantine without mutating data.

## Captures

`check` / `hunt --capture` write local provider captures for eval promotion. Promote with `case promote` after human adjudication. See [`EVALS.md`](./EVALS.md).

## Privacy

- No tokens in store JSON, exports, or captures.
- Treat the store as sensitive if it includes private-repo metadata from your token’s visibility.
- Redaction helpers apply to URLs/headers in diagnostics; still avoid pasting verbose logs into public issues.
