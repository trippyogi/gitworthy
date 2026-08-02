# Contributing

Thanks for helping harden gitworthy. The 1.0 goal is a trustworthy, local-first OSS preflight decision engine (CLI + MCP), not a hosted SaaS.

## Before you start

1. Read `README.md`, `SKILL.md`, and `ROADMAP.md`.
2. Prefer an existing roadmap issue (`GW-*` / milestone) over inventing a new feature.
3. For security-sensitive reports, follow `SECURITY.md` (private disclosure).

## Development setup

```sh
pnpm install --frozen-lockfile
pnpm check
```

Requirements: Node 22+, pnpm 10.27.x (see `packageManager` in `package.json`).

Useful commands:

| Command | Purpose |
|---|---|
| `pnpm check` | lint + typecheck + build + unit tests (offline) |
| `pnpm test:unit` | Vitest only (expects `pnpm build` first for compiled-entry coverage) |
| `pnpm test:package` | Pack tarball, install in a clean temp project, smoke CLI |
| `pnpm release:verify` | Version sync + release metadata (set `GITWORTHY_RELEASE_ALLOW_DIRTY=1` while iterating) |
| `pnpm eval:frozen` | Offline adjudicated corpus via provider replay (release-blocking) |
| `pnpm eval:report` | Frozen quality metrics / release gates (GW-023) |
| `pnpm eval:live` | Live/public case compare-only (needs network; `GITHUB_TOKEN` for GitHub cases) |
| `pnpm eval` | Compatibility alias for `eval:live` |
| `gitworthy contention` | In-flight claim / gap / swarm analysis (GW-040–042) |
| `gitworthy check-scope` | Local draft scope_excess vs issue ask |

## Pull request rules

Keep PRs narrowly scoped and independently reviewable.

Every PR description should cover:

1. Problem / failure mode
2. Behavior before (fixture or repro)
3. Behavior after
4. Threat-model note when touching network, git, archives, storage, or parsing
5. Tests added
6. Commands actually run
7. Fixture changes (justify each)
8. Compatibility impact (CLI / MCP / JSON / storage / none)
9. Rollback path
10. Changelog entry under Unreleased or the target version

Additional hard rules:

- One conceptual change per PR.
- No heuristic evidence may independently create hard `SKIP`.
- Do not update evaluation fixtures merely to make a failing test green.
- No network access in unit tests.
- No telemetry additions before 1.0.
- No new runtime dependency without a short rationale in the PR.
- Never commit tokens, `.env` files, captures of private repos, or publisher binaries.

## Honesty contract

Results must say what was checked and what was not checked. Prefer structured findings over prose that agents would need to parse.

## Licensing

By contributing, you agree your contributions are licensed under the MIT License (`LICENSE`). The open-source core remains MIT; hosted/coordination products are post-1.0 and out of scope for this repository's 1.0 release.
