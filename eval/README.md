# Evaluation suites (GW-021 / GW-022)

Gitworthy splits evaluation into three suites with different trust roles.

| Suite | Path | Network | Release blocking | Purpose |
|---|---|---|---|---|
| **frozen** | `eval/frozen/` | Offline (provider fixture replay) | **Yes** | Adjudicated correctness corpus |
| **live** | `eval/live/` | Public GitHub/npm/git | No (advisory) | Ecosystem drift / availability |
| **private** | `eval/private/` (gitignored) | Offline replay of local captures | No | Experiments before promotion |

Generated machine-readable reports land in `eval/reports/` (gitignored). Latest pointers:
`eval/reports/<suite>-latest.json`.

## Commands

```sh
pnpm eval:frozen    # offline; fails CI on fixture/ground-truth mismatch
pnpm eval:live      # needs network + GITHUB_TOKEN for GitHub cases
pnpm eval:private -- --allow-private
pnpm eval           # compatibility alias → live suite
```

Live snapshot updates (never in release CI):

```sh
pnpm eval:live -- --update-snapshots
```

## Promotion rules

1. Capture a public run (`gitworthy check … --capture`) — GW-018.
2. Optionally write a private experiment under `eval/private/` for local iteration.
3. Human-adjudicate ground truth (`failure_mode`, rationale, evidence URLs).
4. Convert capture/promotion material to a provider fixture pack (`fixture_version: 1`).
5. Place the case under `eval/frozen/cases/` and fixtures under `eval/frozen/fixtures/`.
6. Private cases with `classification: frozen` are rejected — promotion is an explicit file move + review.

See `MIGRATION.md` for the legacy `eval/cases.json` → suite layout move.
