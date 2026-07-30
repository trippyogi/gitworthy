# Baseline record — 0.3.10 / Phase 0

Recorded against `main` at `5de1cc315dad6d924c70d49c90ae84c6710c481d` (package version was `0.3.9` at audit; this release bumps to `0.3.10` without decision-behavior changes).

## Environment

| Item | Value |
|---|---|
| OS | Windows 10 (build 26200) |
| Node | v24.18.0 |
| pnpm | 10.27.0 |
| `GITHUB_TOKEN` / `GH_TOKEN` | absent during baseline eval |

## Commands run

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm eval
```

## Results

| Gate | Result |
|---|---|
| Install (frozen lockfile) | pass |
| Typecheck | pass |
| Lint | pass |
| Unit tests | **203 passed** across **38** files |
| Live eval (`pnpm eval`, compare-only) | passed=3, drifted=6, blocked=3, failed=0 (exit 1 due to drift/blocks) |

### Eval detail (no token)

| ID | Status | Name |
|---:|---|---|
| 1 | drifted | PostHog code sleep resume branch scan |
| 2 | passed | PostHog code close tab branch scan |
| 3 | blocked | PostHog context-mill issue 49 (token required) |
| 4 | blocked | PostHog context-mill issue 24 (token required) |
| 5 | passed | ElevenLabs CLI release gap |
| 6 | blocked | ElevenLabs UI duplicate cluster (token required) |
| 7 | passed | OpenClaw contribution policy extraction |
| 8 | drifted | PostHog code worth check issue 2886 |
| 9 | drifted | MCP servers issue 4487 linked open PR |
| 10 | drifted | Temporal TypeScript issue 2151 assigned |
| 11 | drifted | Shopify app JS issue 3110 in-thread PR |
| 12 | drifted | LiveKit agents issue 6291 linked open PR |

## CLI baseline notes

- `gitworthy --help` works from compiled `dist/cli/index.js`.
- Prior to 0.3.10, `--version` was missing (prints help); 0.3.10 adds `--version` / `-V` / `version`.
- Adapter parity and MCP version tests expect the package version string.

## Open follow-ups opened from this baseline

- Live smoke with a read-only GitHub token (cases 3, 4, 6 and drifted linked-work cases).
- Treat drifted live cases as ecosystem drift until frozen/adjudicated eval exists (`0.6.0`).
- Do not change decision policy in 0.3.10.

## Security / OSS hygiene in this release

- Removed tracked `mcp-publisher.exe` binary from the repository.
- Added `SECURITY.md`, `CONTRIBUTING.md`, and issue templates directing vulnerabilities to private disclosure.
