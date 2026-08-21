# CLI reference

Machine users should prefer `--json`. Human mode is multi-line and action-oriented (`docs` / GW-030). Do not parse human text in agents.

Global flags (most commands):

| Flag | Effect |
|---|---|
| `--json` | Versioned JSON on stdout only |
| `--quiet` / `-q` | Suppress progress on stderr |
| `--verbose` / `-v` | Include counters in human output |
| `--help` / `-h` | Usage |
| `--version` / `-V` | Package version |

Exit codes: `0` ACT/success · `10` VERIFY · `20` SKIP · `2` invalid input · `1` operational failure.

## Primary commands

```sh
gitworthy doctor [--full] [--json]
gitworthy check owner/repo#123 [--npm-package name] [--json]
gitworthy hunt owner/repo|org [--max-checks 3] [--manifest path] [--json]
gitworthy portfolio owner/repo|org [--org] [--max-checks 3] [--max-items 10] [--json]
gitworthy prs owner/repo [--json]
gitworthy ci-triage --head-check name:conclusion [--base-check name:conclusion] [--json]
gitworthy history owner/repo --path rel/file [--symbol name] [--term text] [--json]
gitworthy opportunity-ingest --source name --id external-id [--repo owner/repo] [--json]
gitworthy brief <decision_id> [--format human|json|markdown]
gitworthy outcome record owner/repo#123 --event selected [--decision-id id] [--close-reason superseded|stale|withdrawn] [--acted-against-skip] [--pr-url url] [--json]
gitworthy outcome reconcile [--repo owner/repo] [--issue 123] [--author @me] [--write] [--json]
```

### Doctor

Environment capability matrix (`pass` / `warn` / `fail` / `skipped` / `inconclusive`) with remediations. Exit uses verdict mapping (`ACT`/`VERIFY`/`SKIP`). `--full` adds safe `git ls-remote`. `data_store` includes `track_o_debt` (open-lane outcomes without a terminal).

### Check (`worth_check`)

Single-issue preflight. Optional `--probe-glob` / `--probe-contains` / `--probe-template` for release-gap probes. `--capture` writes a local capture (never publishes).

### Hunt

Bounded **issue** discovery + serial preflights. Hunt is scouting, not contribution routing. Resume:

```sh
gitworthy run list [--repo owner/repo] [--json]
gitworthy run resume <run_id> [--json]
```

Cancel with Ctrl+C; hunt persists partial progress when possible.

### Portfolio

Rank issues and PRs by contribution mode. No global ACT/VERIFY/SKIP. `dispatch_state` is capacity, not a rewrite of `primary_mode`.

```sh
gitworthy portfolio owner/repo [--max-checks 3] [--max-items 10] [--json]
gitworthy portfolio org-name --org [--json]
```

### PR scan

```sh
gitworthy prs owner/repo [--include-bots] [--include-merged] [--json]
```

### CI triage / history / ingest

Caller-supplied later slices. History is not automatic archaeology for every issue.

```sh
gitworthy ci-triage --head-check test:failure --base-check test:success [--json]
gitworthy history owner/repo --path src/core/hunt.ts --symbol hunt [--json]
gitworthy opportunity-ingest --source hermes-eval --id case-9 [--repo owner/repo] [--json]
```

History uses a matching local checkout (`GITWORTHY_LOCAL_REPO` or cwd origin). Remote clone is opt-in (`GITWORTHY_HISTORY_CLONE=1`).

### Watch

Local-only registry. Recheck compares fingerprints and reports field deltas. Never writes to GitHub.

```sh
gitworthy watch add owner/repo#123 [--note text] [--json]
gitworthy watch list [--json]
gitworthy watch recheck <watch_id> [--json]
```

## Evidence / store commands

```sh
gitworthy scan owner/repo [--label …] [--keywords …] [--json]
gitworthy prs owner/repo [--json]
gitworthy watch add owner/repo#123 [--json]
gitworthy ci-triage --head-check name:conclusion [--json]
gitworthy history owner/repo --path rel/file [--json]
gitworthy opportunity-ingest --source name --id id [--json]
gitworthy branches owner/repo keyword[,keyword] [--json]
gitworthy linked owner/repo 123 [--json]
gitworthy contention owner/repo 123 [--json]
gitworthy check-scope owner/repo 123 [--diff path] [--json]
gitworthy policy owner/repo [--json]
gitworthy release owner/repo package-name [--json]
gitworthy ledger list|show|record …
gitworthy store rebuild-indexes|target|export|…
gitworthy recheck owner/repo#123 [--json]
gitworthy mcp
gitworthy mcp --http [--host 127.0.0.1] [--port 8787]
```

## Config

```sh
gitworthy init [--user|--repo]
gitworthy config validate [--json]
gitworthy config show --effective [--json]
gitworthy profile show [--json]
```

See [`CONFIG.md`](./CONFIG.md).

## Examples

```sh
export GITHUB_TOKEN=…   # or GH_TOKEN
gitworthy doctor --json
gitworthy check vercel/next.js#12345 --json
gitworthy hunt vercel/next.js --max-checks 3 --json
```

## Related

- Verdicts: [`VERDICTS.md`](./VERDICTS.md)
- MCP: [`MCP.md`](./MCP.md)
- Troubleshooting: [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
