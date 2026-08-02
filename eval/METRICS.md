# Eval quality metrics (GW-023)

Deterministic release-quality metrics derived from **adjudicated frozen cases** and the latest
`eval/reports/frozen-latest.json` suite output.

## Command

```sh
pnpm eval:frozen   # produce suite results first
pnpm eval:report   # quality gates + JSON/summary artifacts
```

Optional flags:

```sh
pnpm eval:report -- --milestone=0.6.0
pnpm eval:report -- --suite-report=eval/reports/frozen-latest.json
pnpm eval:report -- --output=eval/reports
```

Artifacts (gitignored under `eval/reports/`):

| File | Purpose |
|---|---|
| `quality-latest.json` | Versioned machine-readable report (`EvalQualityReport`) |
| `quality-latest.summary.txt` | Human-readable summary |
| `quality-ci-summary.txt` | Same summary for CI upload |

## Metric definitions

All verdict metrics use **adjudicated frozen cases only** (`ground_truth` present).

| Metric | Denominator | Notes |
|---|---|---|
| Hard-SKIP precision | Observed `SKIP` with paired expected verdict | TP = expected & observed `SKIP`; FP = false hard SKIP |
| False hard SKIP | Adjudicated verdict cases | Observed `SKIP` when expected is not `SKIP` — **release FAIL** |
| ACT precision | Expected `ACT` with observed verdict | Correct `ACT` / adjudicated investigated `ACT` cases |
| VERIFY by reason | Cases with expected or observed `VERIFY` | Grouped by `failure_mode` / `verify_reason`, not generic failure |
| Coverage gaps | Milestone requirements | Missing failure modes, hard-SKIP paths, error classes |

Mechanism-only sub-command cases (no observed verdict field) are counted for corpus coverage but
excluded from verdict confusion-matrix denominators.

## Milestone gates

Thresholds are versioned in `EVAL_MILESTONE_THRESHOLDS` (`src/contracts/eval.ts`).

| Milestone | Case target | Other gates |
|---|---|---|
| **0.6.0** | ≥30 adjudicated (WARN until met) | Zero false hard SKIP (**FAIL**) |
| **0.7.0** | ≥60, ≥10 repos | Hard-SKIP path coverage |
| **0.8.0** | ≥75 | Zero false hard SKIP |
| **0.9.0** | ≥125, ≥20 repos | Provider/auth error-class coverage |
| **1.0.0** | ≥150 | Zero false hard SKIP; ACT precision ≥90% |

Changing a denominator or gate requires a documented compatibility note in the changelog.

## Exit codes

- `0` — pass or warn-only (e.g. corpus below 0.6.0 case target)
- `1` — at least one **fail** gate (false hard SKIP, incomplete cases, etc.)
