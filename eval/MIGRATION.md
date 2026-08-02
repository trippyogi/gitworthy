# Eval migration (GW-021)

## What changed

| Before | After |
|---|---|
| `eval/cases.json` | `eval/live/cases.json` (versioned catalog + classification) |
| `eval/run-eval.ts` live runner | `eval/run-suite.ts` with `--suite=frozen\|live\|private` |
| `fixtures/case-*.json` result snapshots | `eval/live/snapshots/case-*.json` |
| `pnpm eval` | Forwards to **live**; prefer `pnpm eval:frozen` / `eval:live` |
| Single exit policy | Frozen is release-blocking; live is advisory drift |

Root `fixtures/case-*.json` files remain temporarily for older docs/tests that reference them; new live compares use `eval/live/snapshots/`.

## Classification of legacy cases

See each case's `classification` and `provenance.notes` in `eval/live/cases.json`:

- `live_only` — mutable public state; keep as drift checks
- `promote_candidate` — strong GW-024 promotion targets once replay packs exist
- `frozen` — only under `eval/frozen/`
- `retired` — explicit exclusions (none yet)

## Compatibility

- `pnpm eval` still runs the live suite and accepts `--update-fixtures` as an alias of `--update-snapshots`.
- Passing only the old script without a suite flag is supported via the compatibility entry.
- Fixture **rewrite** of provider packs from live runs is intentionally unsupported.
