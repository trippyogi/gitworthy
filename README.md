# gitworthy
is it worth your commit?

<img width="1082" height="689" alt="image" src="https://github.com/user-attachments/assets/eaaf2d91-5939-4b53-a9e6-727d6002be7c" />
*worth_check on a real issue: SKIP, because the fix is already on an internal branch*

gitworthy is an open-source pre-flight tool for OSS contribution targets. Before a human or agent invests time in someone else's issue or feature request, it checks whether the work is already done, already in flight, already fixed but unreleased, duplicated, or genuinely open.

It ships as one package with a shared TypeScript core and two thin adapters:

- CLI for humans, scripts, and CI.
- MCP server over stdio for agent harnesses.

No telemetry is active by default. Optional PostHog telemetry requires both `GITWORTHY_TELEMETRY=on` and `GITWORTHY_POSTHOG_KEY`, plus a user-installed `posthog-node` package. If telemetry is requested but `posthog-node` is missing, gitworthy prints one warning and continues with telemetry disabled. The MCP server path emits no telemetry at all.

## Agent workflow

Agents and MCP clients must follow the mandatory OSS contribution loop in [SKILL.md](./SKILL.md): run `contrib_policy` before forking, pick a contribution path from the policy path matrix, treat ACT results as a scout queue (not claimable until evidence is read), re-run `worth_check` at claim time, then fork → repro → implement → Bugbot → PR or comment. The Cursor rule at [.cursor/rules/oss-contrib-loop.mdc](./.cursor/rules/oss-contrib-loop.mdc) enforces the same ordering in this repo.

## Quickstart

```sh
npx -y gitworthy@0.3.3 check owner/repo#123
npx -y gitworthy@0.3.3 check owner/repo#123 --npm-package package-name --json
npx -y gitworthy@0.3.3 scan Shopify/cli --label "good first issue" --json
npx -y gitworthy@0.3.3 mcp
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
      "args": ["-y", "gitworthy@0.3.3", "mcp"],
      "env": { "GITHUB_TOKEN": "github_pat_..." }
    }
  }
}
```

The token needs only fine-grained, read-only access to public repositories.

## Configuration

- `GITHUB_TOKEN` enables authenticated GitHub REST checks.
- `GITWORTHY_CACHE_DIR` overrides the default cache at `~/.gitworthy/cache`.
- `GITWORTHY_TELEMETRY=on` plus `GITWORTHY_POSTHOG_KEY` requests optional telemetry. Install `posthog-node` yourself if you want this path active. It is not part of the default install.

When `GITHUB_TOKEN` is absent, checks that require GitHub REST return structured errors or explicit `not_checked` entries. Checks that can use public git or npm endpoints still run.

## Requirements 
Node 22 or newer required.

## Core checks

### branch_scan

Lists remote heads with `git ls-remote --heads`, filters branch names by lexical keyword matches, and reports matching branches. With a GitHub token, it also fetches tip commit date and subject.

### issue_vs_main

Fetches issue metadata, shallow clones main, extracts deterministic candidate terms from the issue title and body, and searches paths plus file contents for overlap.

### release_gap

Fetches npm metadata, reads package version from main, and compares it to npm latest. `--npm-package` alone reports package release state; it does not prove an issue-specific fix shipped. Emit `released_fix` only when you also pass a tarball probe (`--probe-glob` + `--probe-contains`) and that probe matches in the published artifact.

### dupe_cluster

Fetches the target issue, searches GitHub issues for distinctive title tokens, lists open issues, and scores lexical similarity.

### linked_work

Fetches issue timeline cross-references, explicit issue-number PR mentions, and current assignees. It emits `linked_pr_open` for open linked PRs, `linked_pr_merged` for merged linked PRs, and `assigned` for maintainer assignment. PR linkage depends on GitHub cross-reference events or explicit issue-number mentions, so unrelated PRs remain invisible.

### contrib_policy

Reads common contribution policy files from main or master and extracts deterministic policy signals with raw excerpts. If docs state that pull requests are not accepted or will be auto-closed, it emits `no_pr_path` and extracts the stated alternate feedback channel when present.

### scan

Tracker triage only: lists open issue tracker candidates, including candidate assignee logins from the issue API response. Scan does not vet issues and does not produce ACT, VERIFY, or SKIP verdicts. It appends a one-line cached contribution-policy hint when available, or reminds you to run policy before investing. Use it to find candidate issue numbers, then run `gitworthy check owner/repo#123` on specific targets.

Example composition:

```sh
gitworthy scan Shopify/cli --label "good first issue" --json
# then pass selected issue numbers to gitworthy check
```

### worth_check

Composes the checks into ACT, VERIFY, or SKIP. Any sub-check error forces VERIFY. `linked_pr_open` forces SKIP with the PR citation. `assigned` caps ACT at VERIFY with the assignee and assignment date. The `no_pr_path` signal caps ACT at VERIFY with the alternate feedback channel, because a repo with no PR path has no direct contribution path. Sub-results remain visible in full.

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
