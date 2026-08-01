<p align="center">
  <img src="./assets/gitworthy-mascot.svg" width="144" alt="Gitworthy pixel mascot">
</p>

<h1 align="center">Gitworthy</h1>

<p align="center">
  <strong>The decision layer before a coding agent starts work.</strong>
</p>

<p align="center">
  Gitworthy checks whether a software task is already done, already in flight,
  blocked by repository policy, duplicated, or genuinely ready to start.
  It returns <code>ACT</code>, <code>VERIFY</code>, or <code>SKIP</code>
  with the evidence behind the decision.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/gitworthy"><img alt="npm" src="https://img.shields.io/npm/v/gitworthy"></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-f59a17"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%3E%3D22-f4d995">
</p>

<p align="center">
  <a href="#use-it-with-cursor-or-any-mcp-client">MCP</a> ·
  <a href="#try-it-in-30-seconds">CLI</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="./CASE_STUDIES.md">Case studies</a> ·
  <a href="./ROADMAP.md">Roadmap</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

---

## Why Gitworthy

Coding agents make implementation cheap. Choosing the wrong task is still expensive.

An issue can look open while:

- a fix already exists on an unlinked branch;
- another contributor has an active pull request;
- the change landed on `main` but has not been released;
- the repository requires assignment before accepting work;
- a duplicate or abandoned implementation already contains the answer.

Gitworthy performs that preflight before a human or agent spends the next unit of work.

```text
Issue or feature request
          │
          ▼
      Gitworthy
          │
     ┌────┼──────┐
     ▼    ▼      ▼
    ACT  VERIFY  SKIP
  proceed inspect stop
```

## Use it with Cursor or any MCP client

Add Gitworthy as an MCP server:

```json
{
  "mcpServers": {
    "gitworthy": {
      "command": "npx",
      "args": ["-y", "gitworthy@latest", "mcp"],
      "env": {
        "GITHUB_TOKEN": "github_pat_..."
      }
    }
  }
}
```

Then give your agent this rule:

> Before implementing an issue in an external repository, run Gitworthy.
> Proceed on `ACT`, perform the named checks on `VERIFY`, and do not begin
> parallel work on `SKIP`.

The token only needs read access to public repositories. For the most accurate linked-work detection, use a classic PAT or a fine-grained token with **Issues: Read** so Gitworthy can see timeline cross-references. Weaker tokens still work, but missing visibility is reported in `not_checked`.

## Try it in 30 seconds

Check that your environment is ready:

```sh
npx -y gitworthy@latest doctor --json
```

Evaluate a specific issue:

```sh
npx -y gitworthy@latest check owner/repo#123
```

Find and preflight a short list of contribution targets:

```sh
npx -y gitworthy@latest hunt owner/repo --json
npx -y gitworthy@latest hunt openclaw --max-checks 3 --json
```

Use `@latest` for exploration. Pin a version in repeatable agent workflows and CI.

## ACT, VERIFY, or SKIP

| Verdict | Meaning | Agent behavior |
|---|---|---|
| **ACT** | Completed checks found no blocking evidence. | Proceed, while reading the evidence and repository policy. |
| **VERIFY** | A named check, coordination step, or missing capability still matters. | Pause and perform the requested verification. |
| **SKIP** | Definitive evidence says parallel implementation should not begin. | Stop, inspect the cited work, or choose another task. |

A verdict is not a vibes-based score. Gitworthy returns structured evidence, the checks it completed, and the checks it could not complete.

## A real preflight

A target issue in `block/buzz` appeared open, but a prior implementation already existed in a pull request using nearly the same title.

```text
Target: block/buzz#1659
Verdict: VERIFY
Disposition: review

Evidence:
- An implementation exists in PR #1675.
- The pull request is linked work, not a duplicate issue.

Next action:
Inspect the current implementation before starting parallel work.
```

That case also exposed a false-positive path in duplicate detection: GitHub's issues API includes pull requests. The fix became a regression test and calibration case.

More real contribution sessions are documented in [CASE_STUDIES.md](./CASE_STUDIES.md).

## How it works

Gitworthy combines bounded checks that answer different ways a task can be unsafe or wasteful to start.

| Check | What it protects against |
|---|---|
| **Linked work** | Existing pull requests, assignments, referenced commits, and prior attempts |
| **Branch scan** | Work already present on unlinked remote branches |
| **Issue vs. main** | Fixes that landed while the issue remained open |
| **Release gap** | Changes on `main` that are not in the published package |
| **Contribution policy** | Claim requirements, assignment rules, and repositories that do not accept pull requests |
| **Duplicate analysis** | Related or previously reported issues |
| **Hunt** | Wasteful broad scans by narrowing candidates before expensive checks |

The CLI and MCP server are thin adapters over the same TypeScript core.

## Trust model

Gitworthy is designed to be useful without pretending to know more than it checked.

- Heuristic evidence cannot independently create a hard `SKIP`.
- Hard `SKIP` requires definitive evidence.
- Failed mandatory checks cap the result at `VERIFY`.
- Every real result includes meaningful `checked` and `not_checked` fields.
- Human-readable prose is never parsed to decide the verdict.
- Target repositories and packages are treated as hostile input.
- Telemetry is off by default. The MCP path emits no telemetry.

`ACT` does not mean “blindly start coding.” Read the evidence, disposition, reasons, and repository policy before investing.

## Agent-native output

Every core result includes a structured envelope:

```json
{
  "verdict_summary": "one sentence",
  "evidence": [],
  "signals": [],
  "checked": [],
  "not_checked": [],
  "cached": false,
  "fetched_at": "2026-01-01T00:00:00.000Z"
}
```

`signals` is the load-bearing input to the decision policy. `checked` and `not_checked` are part of the result, not footnotes.

## Common commands

```sh
gitworthy check owner/repo#123 [--npm-package name] [--json]
gitworthy hunt owner/repo [--max-checks 3] [--json]
gitworthy scan owner/repo [--label "help wanted"] [--json]
gitworthy org owner [--max-repos 8] [--json]
gitworthy policy owner/repo [--json]
gitworthy related owner/repo [issue] [--json]
gitworthy ledger show owner/repo#123 [--json]
gitworthy doctor [--json]
gitworthy mcp
```

Exit codes for `check`:

- `0` — ACT
- `10` — VERIFY
- `20` — SKIP
- `1` — error

See [SKILL.md](./SKILL.md) for the recommended agent hunt loop.

## Configuration

- `GITHUB_TOKEN` / `GH_TOKEN` enables authenticated GitHub REST checks.
- `GITWORTHY_CACHE_DIR` overrides the cache under `~/.gitworthy/cache`.
- `GITWORTHY_LEDGER_DIR` overrides local scout history under `~/.gitworthy/ledger`.
- `GITWORTHY_TELEMETRY=on` plus `GITWORTHY_POSTHOG_KEY` requests optional telemetry.

Optional PostHog telemetry also requires a user-installed `posthog-node` package. If it is missing, Gitworthy warns once and continues with telemetry disabled.

Without a GitHub token, checks that require GitHub REST return structured errors or explicit `not_checked` entries. Checks that can use public git or npm endpoints still run.

## Current status

Gitworthy is pre-1.0 and actively hardening its decision contract, hostile-input handling, local outcomes, evaluation corpus, and onboarding.

The 1.0 goal is a trustworthy, local-first CLI and MCP decision engine—not a hosted SaaS and not another coding agent.

See [ROADMAP.md](./ROADMAP.md) for the release ladder.

## Where this is going

Gitworthy is becoming the agent-native readiness layer between task discovery and implementation:

1. discover candidate work;
2. determine whether it is actually ready;
3. return a machine-actionable next step;
4. record what happened;
5. improve future decisions from real outcomes.

The open-source decision engine stays local-first and MIT licensed. Possible post-1.0 layers include shared outcome history, scheduled hunts, private-repository coordination, and an API for agent dispatch.

## Contributing

Gitworthy is built from real cases where apparently open work turned out to be handled, blocked, or unsafe to start.

The most valuable contributions are:

- examples where Gitworthy made the wrong decision;
- repositories or ecosystems it cannot inspect correctly;
- Cursor, Claude Code, Codex, OpenClaw, or other agent integrations;
- improvements to evidence quality and failure reporting;
- new frozen evaluation cases;
- documentation that helps another person get a useful result quickly.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and trust requirements.

## Requirements

- Node.js 22 or newer
- A GitHub token is strongly recommended for real hunts

## Security

Report vulnerabilities privately using [SECURITY.md](./SECURITY.md) or email `security@gitworthy.com`.

## License

MIT
