# Changelog

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
