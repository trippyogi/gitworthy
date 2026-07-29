# Changelog

## Unreleased

## 0.3.5

- Match linked PRs by issue number in **title and body** (title-only `(#N)` no longer dropped).
- Classify open PRs with `closes_issue` when Fixes/Closes/Resolves the target.
- Collect timeline `referenced` commits as evidence (density only; does not force SKIP).
- Warn in `not_checked` when the timeline has activity but no `cross-referenced` events (token visibility gap).
- Add `worth_check.disposition`: `greenfield` | `land_only` | `claim_first` | `blocked` | `crowded` | `review` (verdicts unchanged).
- Stamp every MCP tool response with `gitworthy_version`.
- Perf: parallelize `worth_check` sub-checks; short-circuit after open linked PR (skip clone/branch/dupe); pool shallow clones and cache `ls-remote` heads per repo; cap `branch_scan` matches (15) and tip-commit fetches (8).

## 0.3.4

- Emit `linked_pr_closed` for closed unmerged linked PRs; `worth_check` caps those at VERIFY with a prior-attempt citation.
- Ignore automation-authored linked PRs (Dependabot/Renovate/etc.) so bot cross-references no longer force VERIFY/SKIP.
- Detect unlinked in-flight PRs via title overlap and claim comments ("I've submitted a PR") when issue numbers are missing.
- Enrich closed-unmerged linked PRs with `prior_attempt` / `days_closed` metadata.
- Tighten `branch_scan`: expand broad-token denylist, require a specific token among multi-hits, and match branches that embed the issue number.
- Add `needs_repro` (bug reports without reproduction steps) and `claim_required` (assignment/claim-first policies); both cap `worth_check` at VERIFY.
- Rank `scan` candidates by `quality_score` (repro, labels, staleness, soft asks, assignees) instead of update time alone.
- When a labeled `scan` returns a thin candidate set or only assigned issues, append advisory `widen_hint` evidence with suggestions to broaden triage (no extra GitHub fetches).

## 0.3.3

- Exclude pull requests from `dupe_cluster` candidate sets; emit blocking `duplicate` only at lexical score ≥ 0.65 (medium-confidence hits may remain evidence-only).
- Require an explicit matching tarball probe before emitting `released_fix`; version equality alone no longer proves an issue-specific fix shipped.
- Canonicalize renamed repositories before Search `repo:` queries, with a cache bust + one re-resolve after Search 422 on a cached canonical name; use the resolved default branch in `contrib_policy` raw fetches.
- Make `pnpm eval` compare-only by default; write fixtures only with `--update-fixtures`.
- Sync the MCP server version with `package.json` and return structured `GitworthyError` envelopes from tool handlers.
- Include GitHub `message` / `documentation_url` details in API error messages.
- Add honesty-scoped calibration case studies in `CASE_STUDIES.md`.

## 0.3.1

- Fix Linux/macOS global npm installs where the `gitworthy` bin symlink silently no-oped because CLI entry detection compared the symlink path to the real compiled module path.
- Add compiled-entry coverage for npm-style symlinked bin invocation.

## 0.3.0

- Added `no_pr_path` detection: `contrib_policy` flags repos that reject PRs (mirror/auto-close language) and extracts the alternate feedback channel; `worth_check` caps such repos at VERIFY.
- Added `linked_work` check: detects linked/referenced PRs (open and merged) and assignees from issue timeline and comments; `worth_check` now cites the blocking PR or assignee by number. ACT requires zero open linked PRs and zero assignees.
- `scan` now surfaces assignees per candidate and a cached no-PR policy hint.
- Eval expanded to 12 frozen cases, including four real ACT-precision failures from 2026-07-09.
- Tightened false-SKIP controls: `branch_scan` now requires stronger token-aware matches for broad terms, `dupe_cluster` no longer emits blocking duplicates from weakly titled closed issues, and branch-only `in_flight` downgrades to VERIFY when `linked_work` completed cleanly with no linked PR or assignee.

## 0.2.0

- Add `scan` core, CLI, and MCP tool for listing open issue tracker candidates before running `worth_check`.
- Keep scan explicitly non-verdict-bearing: it returns tracker candidates only and says tracker state can lag reality in `not_checked`.

## 0.1.1

- Reduce evidence noise by filtering generic issue terms before tree, grep, and branch keyword matching, while preserving calibrated `checked` and `not_checked` output.
- Improve contribution policy extraction so each excerpt maps to one best category or is marked ambiguous, avoiding false CLA matches from architecture text.
- Remove `posthog-node` from default dependencies. Telemetry remains off by default and degrades to no-op with a warning if requested without the optional package installed.

## 0.1.0

- Initial release with CLI, MCP server, six core checks, calibrated envelopes, cache support, and live acceptance fixtures.
