# Frozen corpus inventory (GW-024)

Promotion and exclusion record for adjudicated offline cases. Live catalog classification
lives in `eval/live/cases.json`. Private experiments must not become release blockers
without an explicit move into `eval/frozen/`.

**Corpus size:** 31 frozen cases. Suite result: re-verify with `pnpm eval:frozen` after this pack lands (see [`../../docs/CORPUS.md`](../../docs/CORPUS.md) for verdict-scored vs mechanism-only taxonomy).

## Frozen cases

| ID | Function | Failure mode |
|---|---|---|
| `frozen-smoke-dupe` | `dupe_cluster` | `lexical_duplicate_signal_present` |
| `frozen-dupe-closed-title-gate` | `dupe_cluster` | `closed_duplicate_requires_title_gate` |
| `frozen-dupe-ignores-pr-row` | `dupe_cluster` | `pr_row_not_duplicate_issue` |
| `frozen-dupe-medium-lexical` | `dupe_cluster` | `medium_lexical_dupe_without_blocking` |
| `frozen-dupe-no-candidates` | `dupe_cluster` | `greenfield_no_lexical_duplicate` |
| `frozen-branch-in-flight` | `branch_scan` | `branch_scan_in_flight_match` |
| `frozen-branch-no-match` | `branch_scan` | `branch_scan_no_match` |
| `frozen-contrib-claim-required` | `contrib_policy` | `contrib_policy_claim_required` |
| `frozen-contrib-clean` | `contrib_policy` | `contrib_policy_no_blocking_signals` |
| `frozen-contrib-evidence-requirements` | `contrib_policy` | `contrib_policy_evidence_requirements` |
| `frozen-contrib-no-pr-path` | `contrib_policy` | `contrib_policy_no_pr_path` |
| `frozen-contention-superseded-overlap` | `contention` | `contention_superseded_overlapping_claims` |
| `frozen-issue-partial-overlap` | `issue_vs_main` | `issue_vs_main_partial_overlap` |
| `frozen-issue-shipped` | `issue_vs_main` | `issue_vs_main_shipped_overlap` |
| `frozen-linked-assigned` | `linked_work` | `assigned_maintainer_signal` |
| `frozen-linked-automation-ignored` | `linked_work` | `automation_author_ignored` |
| `frozen-linked-closed-unmerged` | `linked_work` | `closed_unmerged_prior_attempt` |
| `frozen-linked-competing-closers` | `linked_work` | `competing_open_closers_density` |
| `frozen-linked-draft-ignored` | `linked_work` | `draft_pr_without_close_ignored` |
| `frozen-linked-empty-timeline` | `linked_work` | `missing_timeline_cross_references` |
| `frozen-linked-merged-verify` | `linked_work` | `linked_pr_merged_verify_path` |
| `frozen-linked-open-closer` | `linked_work` | `open_closing_pr_linked_work` |
| `frozen-linked-title-overlap-only` | `linked_work` | `title_overlap_pr_verify_grade` |
| `frozen-release-released-fix` | `release_gap` | `release_gap_released_fix_probe` |
| `frozen-release-version-only` | `release_gap` | `release_gap_version_only_no_probe` |
| `frozen-repo-rename-canonical` | `linked_work` | `renamed_repo_canonicalization` |
| `frozen-worth-act-greenfield` | `worth_check` | `worth_check_act_greenfield` |
| `frozen-worth-rate-limit-verify` | `worth_check` | `auth_rate_limit_verify_path` |
| `frozen-worth-skip-open-closer` | `worth_check` | `worth_check_skip_open_closer` |
| `frozen-worth-skip-released-fix` | `worth_check` | `worth_check_skip_released_fix` |
| `frozen-worth-verify-assigned` | `worth_check` | `worth_check_verify_assigned` |

## Live promote candidates (not yet frozen)

See `classification: promote_candidate` in `eval/live/cases.json` (`live-003`, `004`, `006`, `007`, `009`, `011`, `012`). These need capture→replay packs before promotion. Maintainer path: [`../../docs/EVALS.md`](../../docs/EVALS.md) (Capture → promote).

## Explicit exclusions / live-only

| Source | Reason |
|---|---|
| CASE_STUDIES Dawn #3921 | Store-reproduced UI; no durable public GitHub oracle for offline replay |
| CASE_STUDIES Firecrawl rename | Mutable rename/search state; keep live until capture pack exists |
| `live-001/002/005/008/010` | `live_only` — mutable branches/assignments/npm latest |

## Gap tracking

Hard-SKIP / VERIFY paths now covered in frozen replay:

- Open PR explicitly closing issue → `frozen-worth-skip-open-closer` (worth_check SKIP / land_only)
- Released_fix with matched probe → `frozen-release-released-fix`, `frozen-worth-skip-released-fix`
- Provider/auth rate-limit failures → VERIFY (`frozen-worth-rate-limit-verify`)
- Contention superseded / overlapping claims → `frozen-contention-superseded-overlap` (mechanism-only; Hermes #76793 narrative on synthetic `acme/widgets`)

Remaining gaps (non-blocking for current corpus):

- Additional contention states (resolved, contested multi-open without supersession)
- Additional npm tarball edge cases (binary fixture maintenance)

## Fixture maintenance notes

Provider packs must match production URL canonicalization:

- GitHub title-overlap search: `repo:{full_name} is:pr is:open {overlapTerms(title,3)}`
- npm registry metadata/tarball: `@scope%2Fpkg` (literal `@`, not `%40`)
- Renamed / aliased repos: comments and linkage use canonical `full_name` from `/repos/{input}`
- `worth_check` composites need duplicate issue-fetch fixtures for parallel sub-checks
- npm tarball probes must be valid `.tgz` bytes (see `scripts/gen-frozen-corpus.ts` `makeTarball`)
- `contention` packs: issue fetch before `linked_work`, then a second JSON exchange per `pulls/{n}` followed by a `body_encoding: text` unified-diff exchange for the same URL (shared GitHub HTTP client / replay transport)
