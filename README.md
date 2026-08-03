<p align="center">
  <img src="./assets/gitworthy-mascot.svg" width="144" alt="Gitworthy pixel mascot">
</p>

<h1 align="center">Gitworthy</h1>

<p align="center">
  <strong>The decision layer before a coding agent starts work.</strong>
</p>

<p align="center">
  Gitworthy helps coding agents scout, rank, and preflight software work before
  they spend cycles implementing it. It finds the strongest candidates, checks
  whether the work is already handled or blocked, and returns evidence-backed
  <code>ACT</code>, <code>VERIFY</code>, or <code>SKIP</code> decisions for each target.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/gitworthy"><img alt="npm" src="https://img.shields.io/npm/v/gitworthy"></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-f59a17"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%3E%3D22-f4d995">
</p>

<p align="center">
  <a href="#use-it-with-cursor-chatgpt-hermes-or-any-mcp-client">MCP setup</a> ·
  <a href="#try-it-in-30-seconds">CLI</a> ·
  <a href="./docs/AGENT_WORKFLOW.md">Agent workflow</a> ·
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

## How agents use Gitworthy

The agent owns the loop. Gitworthy is the MCP decision engine it calls to scout and validate work.

```text
Contribution goal, repository, or organization
                      │
                      ▼
         Cursor / ChatGPT / Hermes / agent
                      │
                 Gitworthy MCP
                      │
                      ▼
        policy → scan → rank → preflight
                      │
             ┌────────┼────────┐
             ▼        ▼        ▼
            ACT     VERIFY    SKIP
          queue it   inspect   drop it
             │
             ▼
       Ranked candidate shortlist
             │
             ▼
         Select a candidate
             │
             ▼
   recheck → reproduce → implement → review
```

There are two distinct lanes:

- **Scout lane:** discover, filter, rank, preflight, and return a shortlist.
- **Execute lane:** select, record intent, recheck fresh state, reproduce, implement, review, and submit through the repository's allowed contribution path.

`ACT` means “worth considering,” not “start coding blindly.” Scout results go stale, so Gitworthy should be run again when an agent actually claims or begins a target.

See [docs/AGENT_WORKFLOW.md](./docs/AGENT_WORKFLOW.md) for the complete agent policy, tool-selection guide, and scout-to-execute handoff.

## Use it with Cursor, ChatGPT, Hermes, or any MCP client

### Local stdio (desktop / agent VM)

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

### Streamable HTTP (Cloud Agents / mobile / iPad)

Run or deploy the same engine over HTTP and point the client at a URL:

```sh
export GITWORTHY_MCP_TOKEN="$(openssl rand -hex 32)"
export GITHUB_TOKEN="github_pat_..."
npx -y gitworthy@latest mcp --http --host 127.0.0.1 --port 8787
```

```json
{
  "mcpServers": {
    "gitworthy": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:GITWORTHY_MCP_TOKEN}"
      }
    }
  }
}
```

Non-loopback binds require `GITWORTHY_MCP_TOKEN`. Keep `GITHUB_TOKEN` on the server. Full deploy and Cloud Agent notes: [docs/HTTP_MCP.md](./docs/HTTP_MCP.md). Tool descriptions, annotations, and structured results: [docs/MCP.md](./docs/MCP.md).

Give the agent a policy like this:

> Use Gitworthy before investing in external repository work. Use `hunt` to
> build a short ranked queue. Read each candidate's `worth_check`; `hunt` does
> not produce one global verdict. Treat `ACT` as a queue candidate, perform the
> named checks on `VERIFY`, and remove `SKIP` candidates. Before implementing a
> selected target, rerun `worth_check` and follow the repository's contribution
> policy.

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

Render a deterministic handoff brief from a stored decision:

```sh
npx -y gitworthy@latest brief decision_abc123 --format markdown --out brief.md
```

Brief generation is read-only over the local store and never calls GitHub, npm, or an LLM. Stored decisions are considered stale after 24 hours; stale briefs warn and recommend `recheck`.

Scout and preflight a short list of contribution targets:

```sh
npx -y gitworthy@latest hunt owner/repo --json
npx -y gitworthy@latest hunt openclaw --max-checks 3 --json
```

Use `@latest` for exploration. Pin a version in repeatable agent workflows and CI.

## What `hunt` actually returns

`hunt` is a bounded funnel, not a bulk verdict command:

```text
contribution policy
        ↓
scan repository or organization
        ↓
rank issue quality and optional skill fit
        ↓
remove obvious land-only, assigned, weak, or known-SKIP rows
        ↓
run worth_check on only the best few candidates
        ↓
return candidates with individual verdicts and evidence
```

The agent should read each `hunt_candidate.worth_check`. Gitworthy intentionally avoids running an expensive full preflight on every issue returned by a broad scan.

## ACT, VERIFY, or SKIP

| Verdict | Scout behavior | Execution behavior |
|---|---|---|
| **ACT** | Add it to the ranked queue after reading evidence. | Recheck before claiming or implementing; proceed only if fresh state and policy still allow it. |
| **VERIFY** | Surface it with the unresolved checks named. | Resolve those checks before forking or making a public claim. |
| **SKIP** | Remove it from the queue. | Do not begin parallel work; inspect the cited work or choose another target. |

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
| **Scan / org scan** | Unranked issue tracker noise |
| **Hunt** | Wasteful broad checking by narrowing candidates before expensive preflight |

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
- Scout results are not treated as permanent; execution requires fresh revalidation.

`ACT` does not mean “blindly start coding.” Read the evidence, disposition, reasons, linked work, and repository policy before investing.

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
gitworthy hunt owner/repo [--manifest path] [--max-checks 3] [--json]
gitworthy scan owner/repo [--label "help wanted"] [--json]
gitworthy org owner [--manifest path] [--max-repos 8] [--json]
gitworthy policy owner/repo [--json]
gitworthy init [--user] [--repo] [--json]
gitworthy config validate [--path path] [--manifest path] [--json]
gitworthy config show --effective [--json]
gitworthy profile show [--json]
gitworthy related owner/repo [issue] [--json]
gitworthy ledger show owner/repo#123 [--json]
gitworthy doctor [--json]
gitworthy mcp
gitworthy mcp --http [--host 127.0.0.1] [--port 8787] [--stateless]
```

Exit codes for `check`:

- `0` — ACT
- `10` — VERIFY
- `20` — SKIP
- `1` — error

See [SKILL.md](./SKILL.md) for the strict contribution gates and [docs/AGENT_WORKFLOW.md](./docs/AGENT_WORKFLOW.md) for the explanatory workflow guide.

## Configuration

- `GITHUB_TOKEN` / `GH_TOKEN` enables authenticated GitHub REST checks.
- Config files are data-only JSON. Gitworthy reads user config from `~/.gitworthy/config.json` and repository-local config from `.gitworthy/config.json`.
- Precedence is: CLI/MCP input, `GITWORTHY_*` environment variables, repository config, user config, built-in defaults. `gitworthy config show --effective --json` includes provenance for each effective value.
- Create a secret-free skeleton with `gitworthy init --repo` or `gitworthy init --user`. Validate with `gitworthy config validate`.
- Skill profiles (`profile` in config or `--skill-profile`) can include `languages`, `topics`, `preferred_ecosystems`, and avoid lists; they affect scan/hunt ranking inputs only, never hard verdict policy.
- Target manifests (`--manifest path` or `manifest_path` in config) can list repos/orgs, include/exclude filters, per-repo npm package mappings, and target-specific overrides. Ambiguous npm package mappings are rejected. Include/exclude filters are validated and carried as manifest metadata in GW-019; full filtering consumption is deferred to GW-027.
- Tokens and credentials are never persisted in config or manifests; use environment variables such as `GITHUB_TOKEN` / `GH_TOKEN`.
- `GITWORTHY_MCP_TOKEN` is the bearer secret for Streamable HTTP MCP (required for non-loopback binds).
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
2. rank the most promising targets;
3. determine whether each is actually ready;
4. return a machine-actionable next step;
5. revalidate selected work before execution;
6. record what happened;
7. improve future decisions from real outcomes.

The open-source decision engine stays local-first and MIT licensed. Possible post-1.0 layers include shared outcome history, scheduled hunts, private-repository coordination, and an API for agent dispatch.

## Contributing

Gitworthy is built from real cases where apparently open work turned out to be handled, blocked, or unsafe to start.

The most valuable contributions are:

- examples where Gitworthy made the wrong decision;
- repositories or ecosystems it cannot inspect correctly;
- Cursor, ChatGPT, Claude Code, Codex, OpenClaw, Hermes, or other agent integrations;
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
