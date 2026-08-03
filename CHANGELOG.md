# Changelog

## Unreleased

- Docs set for public beta (GW-033): VERDICTS, CLI, CONFIG, DATA, EVALS, SECURITY_MODEL, TROUBLESHOOTING, COMPATIBILITY; README docs router; `pnpm docs:links` in CI.
- Hunt cooperative cancellation via `AbortSignal` / CLI SIGINT with partial persist + resume (GW-036 slice).
- Upgrade smoke script `pnpm test:upgrade` (published → packed workspace → rollback) for GW-037 prep.
- Reliability suite start (GW-036): OS matrix package-smoke, seeded input fuzz, policy hard-SKIP mutation guards, schema inventory.
- MCP contract polish (GW-032): tool metadata, annotations, structuredContent, `pnpm mcp:self-test`.
- Perf counters / human CLI / doctor capability matrix (GW-029–031).
- Add in-flight contention analysis (GW-040–042 / #70–#72): CLI `contention` / `check-scope`, MCP `contention` / `scope_check`, diff-level claim overlap, gap/swarm heuristics, evidence budgets. Roadmap dig-quality track after 0.6 — not a 0.4 reset.
- Add deterministic frozen eval quality report with versioned metrics contracts, milestone release gates, and `pnpm eval:report` artifacts under `eval/reports/` (GW-023 / #32).
- Split evaluation into frozen / live / private suites with versioned case schemas, live classification, and release-blocking frozen CI (`pnpm eval:frozen`) (GW-021 / #30).
- Add injectable provider replay transport and versioned HTTP/git fixture packs for offline frozen cases, plus capture→replay conversion (GW-022 / #31).
- Add Streamable HTTP MCP transport (`gitworthy mcp --http`) with bearer auth, bind policy, serverless handler, and Cloud Agent/mobile docs (GW-039 / #67).
- Add versioned local store under `~/.gitworthy/store` (override with `GITWORTHY_STORE_DIR`): run/decision/outcome records, per-target indexes, and cross-process lockfiles (GW-015).
- Persist check results best-effort into the store from CLI and MCP (commands for browse/export land in GW-017).
- Add safe legacy-ledger migration with quarantine + target-index rebuild (`gitworthy ledger migrate`, `gitworthy store rebuild-indexes`) (GW-016).
- Add store browse/record/recheck/export commands: `run` / `decision` / `outcome` / `recheck` / `store target|export` (GW-017).
- Add opt-in public-repo capture for `check`/`hunt` plus human-reviewed `case promote` for proposed fixtures (GW-018).
- Add versioned, secret-free config files, skill profiles, and target manifests with CLI/MCP show/validate surfaces and effective-value provenance (GW-019).
- Add deterministic read-only `brief <decision_id>` generation for stored decisions in human, JSON, and Markdown formats, with stale-decision warnings and optional config/profile provenance (GW-020 / #29).

## 0.4.1

- Dig-quality: ignore open draft PRs without an explicit closing relationship for linked-work verdict signals (keep as ignored evidence).
- Dig-quality: map merged linked PRs on still-open issues to `close_candidate` VERIFY findings and CLOSE_CANDIDATE next_actions (not a vague VERIFY).
- Dig-quality: rank competing open closers (prefer non-draft, then freshest) and emit land-pick primary + `competing_open_closer` inform findings with `LAND #N` next_actions.
- Dig-quality: when bare clone fails, `issue_vs_main` falls back to `GITWORTHY_LOCAL_REPO` checkout or GitHub contents/raw probes for named path terms (typed `contents_fallback` / `local_checkout` modes).

## 0.4.0

- Add versioned output contracts (`schema_version: 1.0-draft.1`) under `src/contracts/` with generated JSON Schemas in `schemas/`.
- CLI and MCP stamp/validate check results with `run_id` / `decision_id`, and return structured JSON errors (`ok: false`) while preserving legacy `verdict_summary` / `evidence` / `signals` fields.
- Add strict shared CLI/MCP input schemas; unknown flags and malformed refs fail before network access.
- Centralize `worth_check` verdict/disposition in `decideFromSignals` (`src/decision/policy.ts`): heuristics (lexical duplicate, shipped overlap, branch match, title-overlap PRs) cap at VERIFY; only definitive blockers (e.g. released_fix, explicit closing open PR) can SKIP.
- Fix cross-repo linked-work identity (`owner/repo#n` dedupe, timeline/comment PR lookups use the PR's real repo).
- Add bounded shared HTTP client (timeouts, retries, Retry-After, request budgets, GitHub API version headers).
- Replace working-tree inspection with a bare-clone git-object reader (`ls-tree` / `cat-file`, symlink-safe, budgeted).
- Replace whole-tarball extract with streaming `inspectTarball` (path validation, entry/byte/timeout caps).
- Add release-facing hostile-input security suite under `test/security/`.

## 0.3.10

- Establish reproducible baseline documentation (`docs/BASELINE-0.3.10.md`): 203 unit tests, CI, package smoke, release verification.
- Add `gitworthy --version` / `-V` and document it in `--help`.
- Add `pnpm check`, `pnpm test:package`, `pnpm release:verify`, and exact `packageManager` (`pnpm@10.27.0`).
- Add GitHub Actions CI (quality + packed-package smoke).
- Add `CONTRIBUTING.md`, `SECURITY.md`, `ROADMAP.md`, and issue templates (bug, calibration, security redirect).
- Capture legacy pre-1.0 contract notes under `test/contracts/fixtures/`.
- Port missing OSS contribution-loop gates into `SKILL.md` (path matrix, apply-lane revalidation, scout→execute bridge).
- Remove tracked `mcp-publisher.exe` binary from the repository (OSS hygiene).
- No decision-policy or verdict-behavior changes.

## 0.3.9

- Add `related_cluster` (lexical connected-component clustering of related issues; advisory only).
- Hunt hard policy gate: `no_pr_path` blocks worth_check for that repo; `claim_required` warns first (`skip_policy_gate` to disable).
- Named `probe_template`s for `release_gap`/`worth_check` (`changelog`, `readme`, `package-exports`, `dist-index`, `src-index`); `gitworthy probes` / MCP `list_probe_templates`.
- Optional `skill_profile` on scan/org/hunt for portfolio fit ranking (`fit_score`).

## 0.3.8

- Coalesce identical in-flight GitHub GETs and cache successes for 30s (`GITWORTHY_GITHUB_CACHE_MS` to tune/disable TTL).
- Scan keyword filters match **title and body** (catches body-only symptom text).
- `linked_work` adds org-scoped `network_pr` density evidence for fork/sibling PRs (does not force SKIP alone); crowded disposition counts network PRs with referenced commits.
- Add `hunt` CLI/MCP: scan/org_scan → filter land-only/soft-ask/assigned/ledger-SKIP → serial `worth_check` (max 5).

## 0.3.7

- Add `doctor` (CLI/MCP): token, rate limit, auth, timeline cross-ref probe, cache writability, local vs npm version.
- Add `org_scan` / `gitworthy org`: fan out across top public org/user repos with concurrency 2.
- Add scan `likely_land_only` / `land_hint` from assignees + one open-PR search (disable with `--no-land-hints` / `land_hints: false`).
- Add scout ledger (JSON under `~/.gitworthy/ledger`): `ledger_lookup` / `ledger_record` / `ledger_list`; `worth_check` auto-records best-effort.

## 0.3.6

- Hunt policy (SKILL): scan → filter → `worth_check` ≤3–5 survivors, serial per repo (concurrency 1–2).
- Cache clone file lists on the shallow-clone lease so later issues reuse the walk.
- Serialize concurrent shallow clones per repo (shared in-flight create) so parallel `worth_check` sub-checks cannot overwrite the pool.
- Defer `issue_vs_main` tree/grep unless the issue has concrete path terms (`src/…`, `extensions/…`, ≥2 path-like tokens); otherwise assess repro only.
- Add `timings_ms` and `perf` (`clone_cached`, `file_list_cached`, `branch_tip_fetches`, `issue_vs_main_mode`, short-circuit) on `worth_check`.
- Tighten `branch_scan` defaults: 10 evidence matches, 3 tip-commit fetches (issue-number preferred).
- Soft-cap `dupe_cluster` issue listing (1 page) and issue timeline pages (2).
- Document token needs for timeline cross-references in README/SKILL.

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
