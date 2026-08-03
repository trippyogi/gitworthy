# Compatibility and deprecation (pre-1.0)

Schema id today: **`1.0-draft.1`** (`src/contracts/common.ts`). Draft means fields may still change until the GW-035 freeze for 0.9/1.0.

## Public machine surfaces

| Surface | Stability intent | Notes |
|---|---|---|
| CLI `--json` results | Versioned via `schema_version` | Human text is **non-contractual** |
| MCP tool names | Keep through 1.0 | Aliases (`brief` / `brief_show`) documented |
| MCP `structuredContent` + JSON text | Dual representation | Prefer structured |
| Exit codes | Frozen semantics | 0 / 10 / 20 / 2 / 1 |
| Verdict / disposition enums | Frozen set | Additive enums need release notes |
| Generated `schemas/*.json` | CI drift-checked | `pnpm schemas:check` |
| Local store records | Migrated explicitly | Markers under `migrations/` |

## What is not a contract

- Human CLI renderer prose
- Progress lines on stderr
- Ranking score magnitudes (versioned separately; see [`RANKING.md`](./RANKING.md))
- Live eval snapshots

## Deprecation policy (draft → 1.0)

1. Prefer additive optional fields.
2. Rename only with alias period + docs + changelog.
3. Unsupported `schema_version` values fail with structured remediation — never silently reinterpret.
4. Legacy ledger migrates via `gitworthy ledger migrate` (tested in `test/store-migrate.test.ts`).
5. After 1.0 freeze, breaking changes require a major bump and compatibility fixtures.

## Fixture coverage today

- `test/legacy-contract.test.ts` + `test/contracts/fixtures/`
- `test/contracts.test.ts` (`toCheckResult`)
- `test/adapters.test.ts` (CLI/MCP parity samples)
- `test/store-migrate.test.ts`
- `docs/SCHEMA_INVENTORY.json` via `pnpm schemas:inventory`

## Upgrade checklist (maintainers)

1. Bump `SCHEMA_VERSION` only with migration + fixtures.
2. Regenerate schemas (`pnpm schemas:generate`).
3. Update docs in the same PR.
4. Add a frozen eval case for any verdict-policy change.
