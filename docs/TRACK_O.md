# Track O — outcome corpus and verdict calibration

**Spec of record** (v3). Supersedes earlier Track O drafts. Phase 0 artifacts live here and in schemas; Phase 1 ships as a store extension.

## Two tracks

| Track | Purpose | Blocks 1.0 / CI? |
|---|---|---|
| **F (frozen)** | Adjudicated ACT/VERIFY/SKIP + offline replay (`pnpm eval:frozen`) | **Yes** |
| **O (this doc)** | Join T0 verdict → T1 PR outcome; contingency table for product insight | **No** |

Nothing in Track O modifies `eval/frozen/` or the 1.0 gate. See [`CORPUS.md`](./CORPUS.md) and [`EVALS.md`](./EVALS.md) for Track F.

## Phase 0 (locked)

### Outcome labels → store events

| Track O label | Store event | Notes |
|---|---|---|
| merged | `merged` | |
| closed-rejected | `rejected` | Maintainer declined approach |
| closed-superseded | `closed_unmerged` + `close_reason: superseded` | Contention signal |
| closed-stale | `closed_unmerged` + `close_reason: stale` | Bot / inactivity |
| closed-withdrawn | `closed_unmerged` + `close_reason: withdrawn` | Author closed |

Do **not** invent a second T1 vocabulary. Prefer `close_reason` on `closed_unmerged` over a derived enum.

Legacy `closed_unmerged` rows without `close_reason` remain readable; they are omitted from Track O headline tables until adjudicated.

### Join key

Primary: `decision_id`. Also: `run_id`, `repo`, `issue_number`, optional `pr_url`.

Extend the existing decision/outcome store. **No parallel append-only log.**

### Acted on

ACT precision denominator = checks that became a PR (`pr_opened`, or `selected` then a later PR). Abandonment without a PR is not a scorer miss.

### VERIFY

Reported as its own row; never folded into ACT precision.

### Scoring reports (both)

1. merged vs not  
2. merged vs rejected (superseded excluded)

### Contingency table

|  | merged | rejected | superseded | stale/withdrawn |
|---|---|---|---|---|
| ACT | | | | |
| VERIFY | | | | |
| SKIP (acted against) | | | | |

Headline cells: **ACT precision**, **SKIP validation**, **superseded rate under ACT**.

Schemas: `schemas/gitworthy-track-o-join-key.v1.schema.json`, `gitworthy-track-o-contingency.v1.schema.json`, `gitworthy-outcome-event.v1.schema.json`.

### Worked example row

```json
{
  "join": {
    "decision_id": "decision_example",
    "run_id": "run_example",
    "repo": "acme/widgets",
    "issue_number": 76793,
    "pr_url": "https://github.com/acme/widgets/pull/100"
  },
  "verdict_at_t0": "ACT",
  "disposition_at_t0": "greenfield",
  "acted_on": true,
  "outcome_event": "closed_unmerged",
  "close_reason": "superseded",
  "acted_against_skip": false,
  "reconstructed": false
}
```

## Phase 1 — snapshot at check time

On each persisted check:

1. **Verdict inputs** = the durable `decision` (+ `run`) record — what the engine actually saw.
2. **Track O covariates** = optional sibling blob under `store/track-o/covariates/{decision_id}.json`.

Covariates are for later analysis only. **The verdict path must never import or read them** (`src/lib/track-o-covariates.ts` is the only reader/writer). Final-gate statement for any Track O work.

CLI enrichment of richer covariates (contributor count, TTF review, …) can come later; Phase 1 writes a best-effort blob from signals already on the check (no extra GitHub calls, no post-T0 leakage).

## Anti-SKIP policy

SKIP validation needs a denominator. Deliberate, capped practice:

- Cap: **2–3 per quarter**, or **10% of acted cases**, whichever is lower
- Soft SKIP only (crowded / land_only / contention) — never definitive hard SKIP
- Always set `acted_against_skip: true` on the outcome
- Stop if it burns weekends without a new failure mode

```sh
gitworthy outcome record owner/repo#123 \
  --event closed_unmerged \
  --close-reason superseded \
  --acted-against-skip \
  --pr-url https://github.com/owner/repo/pull/1 \
  --json
```

## Multi-agent / same corpus

Track O is **one local directory**, not one MCP process. Every agent on this machine that should contribute to the same corpus must share:

1. **Same binary** — build from `main` (`pnpm build`) and point MCP at that repo’s `dist/cli/index.js`. npm `gitworthy@0.4.0` does **not** write Track O covariates. After `git pull` + `pnpm build`, restart MCP so hosts reload `dist`.
2. **Same store** — default `~/.gitworthy/store` (`%USERPROFILE%\.gitworthy\store` on Windows). If any agent sets `GITWORTHY_STORE_DIR`, **all** agents must use that same absolute path.
3. **Same outcome discipline** — checks auto-write decisions + covariates; T1 labels still need `outcome record` (with `--close-reason` for `closed_unmerged`).

### Per-agent checklist

```sh
node /path/to/gitworthy/dist/cli/index.js --version
# expect the version in package.json on main (e.g. 0.4.1), not an older npm install

node /path/to/gitworthy/dist/cli/index.js doctor --json
# data_store evidence.dir must be the shared store
# local may be ahead of npm_latest until you publish — OK for Track O dogfood
```

Confirm each MCP server’s CLI arg is the **repo `dist`**, not a global `node_modules/gitworthy` from npm.

After a check, confirm growth under the shared store: `decisions/` and `track-o/covariates/`.

Agents on **another machine** do not share this corpus unless you sync that store (private backup only — never commit Track O into the public repo).

## Partitions

| Partition | Meaning |
|---|---|
| `snapshot_backed` | Check ran with live T0 decision (+ covariates flag) |
| `reconstructed` | Phase 2 history backfill; **never mix into headline rates** |

## Phase 1.5 — outcome reconcile (closes the loop)

After execute-lane `pr_opened` (or `selected` + `pr_url`), terminal labels should not stay manual forever.

```sh
# Dry-run (default): list debt + proposed events / needs_adjudication
gitworthy outcome reconcile [--repo owner/repo] [--issue 123] [--author @me] [--json]

# Persist clear terminals only (merged; author-withdrawn; body-superseded)
gitworthy outcome reconcile --write [--json]
```

MCP: `store_outcome_reconcile` (default `dry_run`; set `write: true` to persist).

Rules:

- Joins the **existing** `decision_id` / `run_id` from the open-lane row — never creates reconstructed decisions.
- **Writes:** `merged`; `closed_unmerged`+`withdrawn` when `closed_by` is the author; `closed_unmerged`+`superseded` only from clear body signals.
- **Does not write:** maintainer closes without a clear signal → `needs_adjudication` in the report.
- Idempotent: skips targets that already have a terminal event.
- Doctor `data_store` surfaces `track_o_debt` (count of open-lane targets without terminal).

## Phase 2 — personal history backfill

Reconstruct **clear terminal** outcomes from your own third-party PRs (exclude self-owned orgs). Rows are flagged `reconstructed: true` / `data.reconstructed` and must **not** enter snapshot-backed ACT precision.

```sh
# Inventory + dry-run (default)
pnpm exec tsx scripts/track-o-backfill-authored-prs.ts --author=@me

# Write into local store
pnpm exec tsx scripts/track-o-backfill-authored-prs.ts --author=@me --write
```

Heuristic close reasons for unmerged closes default to `withdrawn` when **`closed_by` matches the author**; otherwise the row is dropped. Override labels with `outcome record --close-reason`. Prefer hand labels for known superseded cases (script includes a small allowlist). Re-runs skip targets that already have any decision (reconstructed or snapshot-backed). Run **reconcile first** for live `pr_opened` debt; use backfill only when there is no snapshot-backed decision.

## Sequencing

1. Phase 0 schemas + `TRACK_O.md` — done (`#80`)  
2. Phase 1 covariates at check time — done (`#80`)  
3. Phase 1.5 outcome reconcile + Track O debt in doctor — this change set  
4. Beta / Track F remain the 1.0 priority  
5. Phase 2 personal history backfill — script in repo; run locally (never commit store)  
6. Phase 3 stranger harvest only if 1+2 are thin (and only with synthesized T0 + caveats)

## Final gate (do not report Track O “complete” without)

1. Per-field leakage check (knowable at T0)  
2. Explicit: `eval/frozen/` and 1.0 gates unchanged  
3. Explicit: no Track O covariate is readable by the verdict path  
