# gitworthy
is it worth your commit?

<img width="1082" height="689" alt="image" src="https://github.com/user-attachments/assets/eaaf2d91-5939-4b53-a9e6-727d6002be7c" />
*worth_check on a real issue: SKIP, because the fix is already on an internal branch*

gitworthy is an open-source pre-flight tool for OSS contribution targets. Before a human or agent invests time in someone else's issue or feature request, it checks whether the work is already done, already in flight, already fixed but unreleased, duplicated, or genuinely open.

It ships as one package with a shared TypeScript core and two thin adapters:

- CLI for humans, scripts, and CI.
- MCP server over stdio for agent harnesses.

No telemetry is active by default. Optional PostHog telemetry requires both `GITWORTHY_TELEMETRY=on` and `GITWORTHY_POSTHOG_KEY`, plus a user-installed `posthog-node` package. If telemetry is requested but `posthog-node` is missing, gitworthy prints one warning and continues with telemetry disabled. The MCP server path emits no telemetry at all.

See `ROADMAP.md` for the path to 1.0, `CONTRIBUTING.md` to develop, and `SECURITY.md` to report vulnerabilities privately.

## Quickstart

```sh
npx -y gitworthy@0.3.10 check owner/repo#123
npx -y gitworthy@0.3.10 check owner/repo#123 --npm-package package-name --json
npx -y gitworthy@0.3.10 hunt owner/repo --json
npx -y gitworthy@0.3.10 hunt openclaw --max-checks 3 --json
npx -y gitworthy@0.3.10 scan Shopify/cli --label "good first issue" --json
npx -y gitworthy@0.3.10 org openclaw --json
npx -y gitworthy@0.3.10 doctor --json
npx -y gitworthy@0.3.10 mcp
```

## CLI

```sh
gitworthy check owner/repo#123 [--npm-package name] [--probe-glob glob] [--probe-contains text] [--json]
gitworthy branches owner/repo keyword[,keyword] [--json]
gitworthy issue owner/repo 123 [--json]
gitworthy release owner/repo package-name [--probe-glob glob] [--probe-contains text] [--json]
gitworthy dupes owner/repo 123 [--json]
gitworthy linked owner/repo 123 [--json]
gitworthy policy owner/repo [--json]
gitworthy scan Shopify/cli --label "good first issue" --json
gitworthy mcp
```

Exit codes for `check`:

- 0 means ACT.
- 10 means VERIFY.
- 20 means SKIP.
- 1 means error.

## Use from an MCP client

```json
{
  "mcpServers": {
    "gitworthy": {
      "command": "npx",
      "args": ["-y", "gitworthy@0.3.10", "mcp"],
      "env": { "GITHUB_TOKEN": "github_pat_..." }
    }
  }
}
```

The token needs only fine-grained, read-only access to public repositories. For accurate `linked_work`, prefer a classic PAT or a fine-grained token with **Issues: Read** so the timeline includes **cross-referenced** events; weaker tokens omit those and under-count prior PRs (gitworthy falls back to title/body search and warns in `not_checked`).

## Configuration

- `GITHUB_TOKEN` / `GH_TOKEN` enables authenticated GitHub REST checks.
- `GITWORTHY_CACHE_DIR` overrides the default cache at `~/.gitworthy/cache`.
- `GITWORTHY_TELEMETRY=on` plus `GITWORTHY_POSTHOG_KEY` requests optional telemetry. Install `posthog-node` yourself if you want this path active. It is not part of the default install.

When `GITHUB_TOKEN` is absent, checks that require GitHub REST return structured errors or explicit `not_checked` entries. Checks that can use public git or npm endpoints still run.

## Requirements 
Node 22 or newer required.

## Core checks

### branch_scan

Lists remote heads with `git ls-remote --heads`, filters branch names by lexical keyword matches (issue-number tokens preferred), and reports matching branches. With a GitHub token, it fetches tip commit date/subject for a small budget (default 3, issue-number first).

### issue_vs_main

Fetches issue metadata and reproduction signals. Tree/grep runs only when the issue names concrete paths (`src/…`, `extensions/…`, or ≥2 path-like tokens); otherwise clone is skipped and `not_checked` explains the gate. When cloning, file lists are cached on the shallow-clone lease.

### release_gap

Fetches npm metadata, reads package version from main, and compares it to npm latest. `--npm-package` alone reports package release state; it does not prove an issue-specific fix shipped. Emit `released_fix` only when you also pass a tarball probe (`--probe-glob` + `--probe-contains`) and that probe matches in the published artifact.

### dupe_cluster

Fetches the target issue, searches GitHub issues for distinctive title tokens, lists a soft-capped page of issues, and scores lexical similarity.

### linked_work

Fetches issue timeline cross-references (soft-capped pages), explicit issue-number PR mentions in **title and body**, comment PR URLs, referenced commits, and high title-overlap open PRs (especially when someone claims they submitted a PR without linking it). It emits `linked_pr_open` for open linked PRs (with `closes_issue` when Fixes/Closes/Resolves), `linked_pr_merged` for merged linked PRs, `linked_pr_closed` for closed unmerged linked PRs (with `prior_attempt` metadata), and `assigned` for maintainer assignment. Automation authors (Dependabot, Renovate, and other bots) are kept in evidence but ignored for verdict signals. Referenced commits are evidence-only and do not force SKIP.

### contrib_policy

Reads common contribution policy files from main or master and extracts deterministic policy signals with raw excerpts. If docs state that pull requests are not accepted or will be auto-closed, it emits `no_pr_path` and extracts the stated alternate feedback channel when present. If docs require claiming or requesting assignment before a PR, it emits `claim_required`.

### hunt

One-shot triage orchestrator: `scan` or `org_scan` → hard policy gate (`no_pr_path` blocks checks for that repo; `claim_required` warns first; `--skip-policy-gate` to disable) → drop likely land-only / soft-ask / assigned / ledger-SKIP rows → serial `worth_check` on up to `--max-checks` (default 3, max 5). Optional `--skill-profile languages=ts,go;topics=mcp;avoid=swift` ranks by `fit_score` after `quality_score`. Returns no ACT/SKIP signals of its own; read each `hunt_candidate.worth_check`. Prefer this over hand-rolling N× checks.

### doctor

Reports hunt readiness: token present, GitHub auth login, rate-limit remaining, timeline cross-reference visibility probe, cache directory writability, and local package version vs npm latest. Does not emit ACT/VERIFY/SKIP signals.

### scan

Tracker triage only: lists open issue tracker candidates ranked by `quality_score` (repro clarity, contributor-friendly labels, staleness, soft asks, assignees). With `--skill-profile`, also computes `fit_score` and sorts by quality then fit. By default also sets `likely_land_only` / `land_hint` from assignees and one open-PR search so agents can skip land-only rows before `worth_check` (disable with `--no-land-hints`). Scan does not vet issues and does not produce ACT, VERIFY, or SKIP verdicts. It appends a one-line cached contribution-policy hint when available, or reminds you to run policy before investing. When a label filter yields a thin set (below `min(5, limit)` candidates) or every remaining candidate is assigned, scan appends a `widen_hint` evidence item with suggestions such as dropping the label, trying `help wanted`, or scanning without a label. Use it to find candidate issue numbers, then run `gitworthy check owner/repo#123` on specific targets.

Example composition:

```sh
gitworthy scan Shopify/cli --label "good first issue" --json
gitworthy org openclaw --max-repos 8 --json
# then pass selected issue numbers to gitworthy check
```

### org_scan

Fans out `scan` across the top public non-fork repos for an org or user (default 8). Candidates are tagged with `repo`, merged, and re-ranked by `quality_score` (then `fit_score` when a skill profile is set). Still tracker-only — run per-repo `policy` / `worth_check` before investing.

### related_cluster

Lexical connected-component clustering of related open issues (token overlap + shared error phrases). Advisory only — no embeddings. CLI: `gitworthy related owner/repo [issue]`.

### probe templates

Named release probes for `check` / `release`: `changelog`, `readme`, `package-exports`, `dist-index`, `src-index`. List with `gitworthy probes` or MCP `list_probe_templates`. Prefer `--probe-template changelog` over hand-rolled globs when one of these fits.

### ledger

Local scout memory under `~/.gitworthy/ledger` (override with `GITWORTHY_LEDGER_DIR`). `worth_check` auto-records verdict/disposition best-effort. Use `ledger show` / `ledger list` to avoid re-checking the same issues across chats.

### worth_check

Composes the checks into ACT, VERIFY, or SKIP, plus a hunt `disposition`: `greenfield` (safe to start), `land_only` (open linked PR — do not open a parallel fix), `claim_first`, `blocked`, `crowded` (dense prior attempts/commits), or `review`. Any sub-check error forces VERIFY. `linked_pr_open` forces SKIP with the PR citation and `land_only`. `linked_pr_closed` and `linked_pr_merged` cap ACT at VERIFY with the PR citation so agents inspect abandoned or landed attempts before claiming. `assigned` and `claim_required` cap ACT at VERIFY so contributors claim/coordinate first. `needs_repro` caps ACT at VERIFY when a bug-shaped issue lacks reproduction steps. The `no_pr_path` signal caps ACT at VERIFY with the alternate feedback channel, because a repo with no PR path has no direct contribution path. Sub-results remain visible in full. Responses include `timings_ms` and `perf` (clone/file-list cache flags, tip-fetch count, short-circuit). ACT is not the same as claimable: always read `linked_work` evidence, `disposition`, and `reasons` before investing. For agent hunts, prefer `scan` → filter → ≤3–5 serial `worth_check`s (see [SKILL.md](./SKILL.md)).

## Output envelope

Every core result includes:

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

`checked` and `not_checked` are load-bearing. Empty `not_checked` on a real result is a bug.

`signals` is the only load-bearing verdict input for `worth_check`. Human-readable prose is never parsed to decide ACT, VERIFY, or SKIP.

## Calibration cases

Real contribution sessions that calibrated false-positive fixes in v0.3.3 (Dawn cart drawer, Buzz PR leakage into duplicate detection, Firecrawl renamed-repo Search, and release-probe semantics) are documented in [CASE_STUDIES.md](./CASE_STUDIES.md).

## Why

gitworthy exists because "this issue looks open" is usually wrong in active repos. Its acceptance suite is frozen from a real contribution session across PostHog, ElevenLabs, and Temporal repositories in July 2026, where six of eight apparent targets were already handled: fixed on an unlinked internal branch, shipped on main with the issue left open, or fixed but not yet released to npm. Every check in this tool is one of the manual verifications that caught those six before any work was wasted. The tool reports what it checked and what it could not check on every result, because unjustified confidence is the failure mode it was built against.

## License

MIT
