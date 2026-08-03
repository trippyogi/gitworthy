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
gitworthy brief <decision_id> [--format human|json|markdown]
gitworthy outcome record owner/repo#123 --event selected [--decision-id id] [--close-reason superseded|stale|withdrawn] [--acted-against-skip] [--pr-url url] [--json]
```

### Doctor

Environment capability matrix (`pass` / `warn` / `fail` / `skipped` / `inconclusive`) with remediations. Exit uses verdict mapping (`ACT`/`VERIFY`/`SKIP`). `--full` adds safe `git ls-remote`.

### Check (`worth_check`)

Single-issue preflight. Optional `--probe-glob` / `--probe-contains` / `--probe-template` for release-gap probes. `--capture` writes a local capture (never publishes).

### Hunt

Bounded discovery + serial preflights. Resume:

```sh
gitworthy run list [--repo owner/repo] [--json]
gitworthy run resume <run_id> [--json]
```

Cancel with Ctrl+C; hunt persists partial progress when possible.

## Evidence / store commands

```sh
gitworthy scan owner/repo [--label …] [--keywords …] [--json]
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
