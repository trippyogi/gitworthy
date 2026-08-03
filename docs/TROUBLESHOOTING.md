# Troubleshooting

Start with doctor — it returns a capability matrix and remediations:

```sh
gitworthy doctor --json
# or human:
gitworthy doctor
```

## Capability → fix

| Capability | Common fix |
|---|---|
| `github_token` fail | Export `GITHUB_TOKEN` or `GH_TOKEN` |
| `github_auth` fail | Token invalid/revoked; create a new PAT/fine-grained token |
| `github_rate_limit` warn | Wait for reset or use a higher-limit token |
| `github_timeline` inconclusive | Grant Issues: Read (classic) or fine-grained Issues permission; re-run against the controlled fixture |
| `npm_registry` warn | Network/registry access; release-gap may degrade |
| `cache_dir` / `data_store` fail | Fix permissions or set `GITWORTHY_CACHE_DIR` / `GITWORTHY_STORE_DIR` |
| `data_store` warn (stale locks) | Confirm no live process; remove only stale locks; consider `store rebuild-indexes` |
| `git` fail | Install git on PATH |
| `node` fail | Upgrade to Node ≥22 (`package.json` engines) |
| `git_ls_remote` skipped | Pass `--full` for release validation |

## MCP

| Symptom | Fix |
|---|---|
| Host can’t see tools | Ensure `npx -y gitworthy@latest mcp` (or pinned version); restart host |
| Stdio corruption | Never print logs to stdout from MCP stdio; use CLI for human progress |
| HTTP 401 | Set `Authorization: Bearer $GITWORTHY_MCP_TOKEN`; see [`HTTP_MCP.md`](./HTTP_MCP.md) |
| Wrong tool for verdicts | Prefer `worth_check` / `hunt`; evidence tools don’t replace them ([`MCP.md`](./MCP.md)) |

## Hunt / check

| Symptom | Fix |
|---|---|
| Partial hunt | Read `partial_reason`; `gitworthy run resume <run_id>` |
| Cancelled mid-hunt | Progress is persisted when possible; resume the run id |
| Unexpected VERIFY | Read `not_checked` and findings; failed providers cap at VERIFY |
| Unexpected SKIP | Require definitive evidence; if wrong, file a bug + frozen regression case |
| Stale ACT | Always `recheck` before implementing |

## Local data

```sh
gitworthy doctor --json          # data_store capability
gitworthy store rebuild-indexes  # indexes only
gitworthy ledger migrate         # legacy ledger lift
```

Never delete the whole store to “fix” schema errors without a backup export.

## Still stuck

- Security/credential issues → private advisory ([`SECURITY.md`](../SECURITY.md))
- Correctness → public issue with `--json` redacted output + case promotion path ([`EVALS.md`](./EVALS.md))
