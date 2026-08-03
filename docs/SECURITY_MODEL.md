# Security model

Gitworthy is a **local-first** decision engine. It inspects hostile remote content (issues, repos, packages) and must never execute target code.

Disclosure and supported versions: [`../SECURITY.md`](../SECURITY.md).

## Trust boundaries

| Boundary | Rule |
|---|---|
| Tokens | Env / external credential tools only — never config, captures, logs, exports |
| HTTP MCP | Non-loopback requires `GITWORTHY_MCP_TOKEN`; see [`HTTP_MCP.md`](./HTTP_MCP.md) |
| Hostile input | No clone hooks, no package install/execution, budgets/timeouts everywhere |
| Archives / git objects | Symlinks not followed; path traversal rejected; byte/entry caps |
| Local store | Corruption / races / silent loss are reliability bugs for 1.0 |

## What Gitworthy will not do

- Write to GitHub issues/PRs
- Claim issues or open PRs
- Require telemetry
- Treat `ACT` as “safe to ship without recheck”

## Test gates

Offline suite under `test/security/` (symlink hostility, budgets, binary blobs, path traversal, timeouts, invalid CLI/MCP input). Related: `test/lib/git.test.ts`, `test/lib/registry-tarball.test.ts`, adapter input validation tests.

## Redaction

Verbose diagnostics and HTTP logs use redaction helpers for Authorization and sensitive URL query parts. Prefer `--json` over pasting human verbose output into tickets.
