# Corpus status and taxonomy

Last verified: offline `pnpm eval:frozen` + `pnpm eval:report` on current `main` lineage.

## What “0.6 PASS” actually means

| Signal | Current value | Meaning |
|---|---|---|
| Frozen suite rows | **30 / 30 passed**, `failed=0` | Engine matches offline fixtures. **There is no 12/30 suite failure rate today.** |
| Quality milestone | `0.6.0` release **PASS** | Volume floor (≥30) + **zero false hard SKIP** on verdict-scored cases |
| Verdict-scored cases | **5** | `worth_check` cases that emit `observed_verdict` (ACT/VERIFY/SKIP precision math) |
| Mechanism-only cases | **25** | Sub-tool cases (`linked_work`, `dupe_cluster`, `contrib_policy`, …) with expected signals/paths; they **pass** the suite but are not counted in ACT/SKIP precision denominators |

If someone says “12 of 30 fail,” that does **not** match the current frozen suite. Likely confusion with mechanism-only counts, an older report, or live-suite drift. Always re-check:

```sh
pnpm eval:frozen   # look at summary failed=
pnpm eval:report   # look at verdict-scored vs mechanism-only
```

## Taxonomy before growing volume

### A — Suite failures (engine defects)

Cases where replay **fails** (`status=failed` / product regression).  
**Action:** fix engine or fix fixture; do not promote more of the same shape until green.

**Current count: 0.**

### B — Verdict-scored adjudications (precision corpus)

`worth_check` (and later hunt decision) cases with both expected and observed verdict.

| ID | Expected | Role |
|---|---|---|
| `frozen-worth-act-greenfield` | ACT | Honest greenfield |
| `frozen-worth-verify-assigned` | VERIFY | Assignment gate |
| `frozen-worth-rate-limit-verify` | VERIFY | Provider failure caps at VERIFY |
| `frozen-worth-skip-open-closer` | SKIP | Definitive open closer |
| `frozen-worth-skip-released-fix` | SKIP | Released fix probe |

**Current count: 5.** This is the thin precision denominator product should worry about — not suite pass rate.

### C — Mechanism-only (path coverage)

Deliberate hard / edge paths for sub-checks. They are **not** failures. Each has a recorded `failure_mode` in `eval/frozen/INVENTORY.md` and case JSON rationale.

**Current count: 25.** Growing to 150 by cloning only mechanism cases does not improve ACT precision gates.

## What 1.0 should gate on (proposal)

Keep **false hard SKIP = 0** as a hard fail forever.

Add explicit targets (write into GW-038 when cutting RC):

| Gate | Suggested 1.0 bar |
|---|---|
| Frozen suite pass rate | **100%** on release corpus (no known failing fixtures) |
| False hard SKIP | **0** |
| Verdict-scored ACT precision | **≥ 0.90** with denominator ≥ 30 investigated ACT |
| Hard-SKIP adjudicated count | **≥ 30** verdict-scored SKIP with definitive rationale |
| Total frozen cases | **≥ 150** with mix of B+C, not C alone |

If suite pass rate dropped below ~0.95 with unexplained failures, that is an **engine** problem — stop promotions until triaged.

## Sequencing (product)

1. **Run GW-034 beta now** on a pinned build (`0.4.1` or next labeled RC).
2. Grow **Track F** corpus **from beta dogfood** (false SKIP / wrong ACT / surprising VERIFY), not from solo fixture farming.
3. **Track O** (outcome calibration) runs in parallel and does **not** change the 1.0 frozen gate — see [`TRACK_O.md`](./TRACK_O.md). Snapshot-at-check ships so OSS PRs can join later.
4. Promote mechanism packs as secondary — they help coverage, not the human blockers.

See [`BETA.md`](./BETA.md).
