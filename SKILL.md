# gitworthy skill

Use gitworthy before spending time on an external repository issue or feature request.

## Hunt loop (perf)

Wall time is usually **N × worth_check**, not one slow check. Prefer a narrow funnel:

1. `npx gitworthy policy owner/repo --json` on unfamiliar repos.
2. `npx gitworthy scan owner/repo --json` (optional `--label`, `--keywords`, `--since`).
3. **Prefilter** scan hits before any `worth_check`:
   - skip assigned / `soft_ask: true` / thin descriptions unless explicitly hunting those
   - skip anything already labeled or known as linked-PR-open / land-only
   - prefer higher `quality_score` and clear repro
4. Run **`worth_check` on at most 3–5** survivors.
5. **Serial `worth_check` per repo** (max concurrency **1–2**). Parallel MCP calls on the same large repo thrash clone/`ls-remote`/API budgets and erase pool wins.

Do **not** worth_check every scan row.

## Commands

Ordering rule: run contribution policy before investing in any unfamiliar repo. Use `npx gitworthy policy owner/repo --json`, or `npx gitworthy scan owner/repo --json` only as tracker triage and follow its policy reminder when no cached policy exists.

```sh
npx gitworthy check owner/repo#123 --json
```

If the project publishes an npm package, include it:

```sh
npx gitworthy check owner/repo#123 --npm-package package-name --json
```

`--npm-package` alone reports package release state; it does not prove an issue-specific fix shipped. For that, add `--probe-glob` and `--probe-contains` so `release_gap` can search the published tarball.

## Interpretation

- ACT means the completed deterministic checks did not find a blocking signal.
- VERIFY means a human must perform the named checks before investing or making any public claim. If `assigned` or `claim_required` is present, coordinate or claim before acting. If `needs_repro` is present, reproduce the failure first. If `linked_pr_closed` is present, read the prior attempt before retrying. If `no_pr_path` is present, do not plan a PR unless the stated feedback channel says otherwise.
- SKIP means the tool found a strong signal that the work is already handled, in flight, linked to an open PR, released, or duplicated.
- `disposition` refines hunt action without changing the verdict: `land_only` = review/land the open linked PR (do not open a parallel fix); `greenfield` = start work; `crowded` = dense prior attempts; `claim_first` / `blocked` / `review` as named.
- Read `timings_ms` and `perf` on `worth_check` when optimizing hunts (`clone_cached`, `file_list_cached`, `branch_tip_fetches`, short-circuit flags).

`scan` ranks tracker candidates by `quality_score` (repro clarity, labels, staleness, soft asks, assignees). Higher scores are better triage starts; scan still does not vet contribution targets—always follow with `worth_check` on a **short** list.

Mandatory rule: never make a public claim from a VERIFY verdict without performing the named human checks.

Always read `checked`, `not_checked`, and the evidence URLs. The limitations are part of the result, not footnotes.

## Token note

For accurate `linked_work`, `GITHUB_TOKEN` must see issue **timeline cross-referenced** events (classic PAT, or fine-grained with **Issues: Read**). Weak tokens omit cross-links and under-count prior PRs; gitworthy falls back to title/body search and warns in `not_checked`. Prefer the same token quality you use with `gh` for hunts.
