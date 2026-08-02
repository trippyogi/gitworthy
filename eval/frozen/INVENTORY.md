# Frozen corpus inventory (GW-024)

Promotion and exclusion record for adjudicated offline cases. Live catalog classification
lives in `eval/live/cases.json`. Private experiments must not become release blockers
without an explicit move into `eval/frozen/`.

## Frozen cases

| ID | Failure mode | Source |
|---|---|---|
| `frozen-smoke-dupe` | `lexical_duplicate_signal_present` | Hand-authored smoke (GW-022) |
| `frozen-dupe-ignores-pr-row` | `pr_row_not_duplicate_issue` | Case study 2 / buzz lesson |
| `frozen-dupe-no-candidates` | `greenfield_no_lexical_duplicate` | Greenfield ACT-adjacent mechanism |
| `frozen-dupe-closed-title-gate` | `closed_duplicate_requires_title_gate` | Closed-issue title threshold |

## Live promote candidates (not yet frozen)

See `classification: promote_candidate` in `eval/live/cases.json` (`live-003`, `004`, `006`, `007`, `009`, `011`, `012`). These need capture→replay packs before promotion.

## Explicit exclusions / live-only

| Source | Reason |
|---|---|
| CASE_STUDIES Dawn #3921 | Store-reproduced UI; no durable public GitHub oracle for offline replay |
| CASE_STUDIES Firecrawl rename | Mutable rename/search state; keep live until capture pack exists |
| CASE_STUDIES release version equality | Needs npm tarball bytes in fixtures (binary) — deferred |
| `live-001/002/005/008/010` | `live_only` — mutable branches/assignments/npm latest |
| Hermes contention #76793 narrative | Guides GW-040–042; promote as frozen contention case after dedicated fixture pack |

## Gap tracking (hard-SKIP paths)

Definitive hard-SKIP paths still needing frozen coverage (tracked for GW-024 continuum):

- Open PR explicitly closing issue → SKIP land_only
- Released_fix with matched probe → SKIP
- Provider/auth failures → VERIFY (not SKIP)

Corpus count remains below the 0.6 WARN target of 30 until further promotions land.
