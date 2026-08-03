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

## Partitions

| Partition | Meaning |
|---|---|
| `snapshot_backed` | Check ran with live T0 decision (+ covariates flag) |
| `reconstructed` | Phase 2 history backfill; **never mix into headline rates** |

## Sequencing

1. Phase 0 in repo (this doc + schemas) — done with this change set  
2. Phase 1 store extension before OSS PRs that should join Track O  
3. Beta / Track F remain the 1.0 priority  
4. Phase 2 personal history backfill when quiet  
5. Phase 3 stranger harvest only if 1+2 are thin (and only with synthesized T0 + caveats)

## Final gate (do not report Track O “complete” without)

1. Per-field leakage check (knowable at T0)  
2. Explicit: `eval/frozen/` and 1.0 gates unchanged  
3. Explicit: no Track O covariate is readable by the verdict path  
