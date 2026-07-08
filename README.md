is it worth your commit?

<img width="1082" height="689" alt="image" src="https://github.com/user-attachments/assets/eaaf2d91-5939-4b53-a9e6-727d6002be7c" />

gitworthy is an open-source pre-flight tool for OSS contribution targets. Before a human or agent invests time in someone else's issue or feature request, it checks whether the work is already done, already in flight, already fixed but unreleased, duplicated, or genuinely open.



It ships as one package with a shared TypeScript core and two thin adapters:

- CLI for humans, scripts, and CI.
- MCP server over stdio for agent harnesses.

No telemetry is active by default. Optional PostHog telemetry requires both `GITWORTHY_TELEMETRY=on` and `GITWORTHY_POSTHOG_KEY`. The MCP server path emits no telemetry at all.

## Quickstart

```sh
npx gitworthy check owner/repo#123
npx gitworthy check owner/repo#123 --npm-package package-name --json
npx gitworthy mcp
```

## CLI

```sh
gitworthy check owner/repo#123 [--npm-package name] [--probe-glob glob] [--probe-contains text] [--json]
gitworthy branches owner/repo keyword[,keyword] [--json]
gitworthy issue owner/repo 123 [--json]
gitworthy release owner/repo package-name [--probe-glob glob] [--probe-contains text] [--json]
gitworthy dupes owner/repo 123 [--json]
gitworthy policy owner/repo [--json]
gitworthy mcp
```

Exit codes for `check`:

- 0 means ACT.
- 10 means VERIFY.
- 20 means SKIP.
- 1 means error.

## Use from an MCP client
{
  "mcpServers": {
    "gitworthy": {
      "command": "npx",
      "args": ["gitworthy", "mcp"],
      "env": { "GITHUB_TOKEN": "github_pat_..." }
    }
  }
}

## Configuration

- `GITHUB_TOKEN` enables authenticated GitHub REST checks.
- `GITWORTHY_CACHE_DIR` overrides the default cache at `~/.gitworthy/cache`.
- `GITWORTHY_TELEMETRY=on` plus `GITWORTHY_POSTHOG_KEY` enables optional telemetry.

When `GITHUB_TOKEN` is absent, checks that require GitHub REST return structured errors or explicit `not_checked` entries. Checks that can use public git or npm endpoints still run.

## Requirements 
Node 22 or newer required.

## Core checks

### branch_scan

Lists remote heads with `git ls-remote --heads`, filters branch names by lexical keyword matches, and reports matching branches. With a GitHub token, it also fetches tip commit date and subject.

### issue_vs_main

Fetches issue metadata, shallow clones main, extracts deterministic candidate terms from the issue title and body, and searches paths plus file contents for overlap.

### release_gap

Fetches npm metadata, reads package version from main, compares it to npm latest, and optionally downloads the latest tarball for a string probe.

### dupe_cluster

Fetches the target issue, searches GitHub issues for distinctive title tokens, lists open issues, and scores lexical similarity.

### contrib_policy

Reads common contribution policy files from main or master and extracts deterministic policy signals with raw excerpts.

### worth_check

Composes the checks into ACT, VERIFY, or SKIP. Any sub-check error forces VERIFY. Sub-results remain visible in full.

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

## Why

gitworthy exists because "this issue looks open" is usually wrong in active repos. Its acceptance suite is frozen from a real contribution session across PostHog, ElevenLabs, and Temporal repositories in July 2026, where six of eight apparent targets were already handled: fixed on an unlinked internal branch, shipped on main with the issue left open, or fixed but not yet released to npm. Every check in this tool is one of the manual verifications that caught those six before any work was wasted. The tool reports what it checked and what it could not check on every result, because unjustified confidence is the failure mode it was built against.

## License

MIT

## v0.1.1 follow-up

Improve evidence signal-to-noise by filtering generic issue terms such as example, add, task, and support, or by ranking tree and grep matches by term specificity before truncation.
