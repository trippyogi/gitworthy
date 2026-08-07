---
name: gitworthy
description: Preflight GitHub contribution targets before investing implementation work. Use before claiming, forking, or opening PRs on external issues; enforces policy → hunt/worth_check → revalidation and Track O outcome discipline.
license: MIT
compatibility: Requires Node.js >= 22, network access to GitHub, and GITHUB_TOKEN (or GH_TOKEN) in the environment for accurate linked_work.
metadata:
  author: trippyogi
  homepage: https://github.com/trippyogi/gitworthy
---

# gitworthy skill

Use gitworthy before spending time on an external repository issue or feature request.

## Mandatory contribution loop

Never invert this order. Scout and execute are separate lanes; execute never skips gates.

```
1. contrib_policy   â†’ 2. hunt/scan (optional)  â†’ 3. worth_check
        â†“
4. ledger record / claim intent  â†’ 5. worth_check again (apply-lane revalidation)
        â†“
6. fork  â†’ 7. repro  â†’ 8. implement  â†’ 9. review  â†’ 10. PR or comment
```

### Gate 1: `contrib_policy` before fork, implement, or PR

Run contribution policy **before** forking, cloning for implementation, or opening a PR:

```sh
npx gitworthy policy owner/repo --json
```

Or use `npx gitworthy scan owner/repo --json` / `npx gitworthy hunt â€¦` only as tracker triage; follow policy reminders when no cached policy exists.

**Do not fork or implement until policy is read and the contribution path is chosen** (see path matrix below).

### Gate 2: Path matrix from policy signals

Pick exactly one contribution path from `contrib_policy` evidence before investing:

| Path | When to use | Deliverable |
|------|-------------|-------------|
| **pr** | Default when policy allows PRs; no `no_pr_path`; no security-only channel | Fork â†’ branch â†’ PR |
| **issue_comment_patch** | `issue_first_or_alignment` in policy; or `no_pr_path` with a forum/discussion/issue feedback channel | Repro + minimal patch or steps in an issue comment (or linked discussion) |
| **security_report** | `SECURITY.md` or policy excerpt requires private disclosure | Report via stated channel; do not open a public PR for the vulnerability |
| **skip** | `worth_check` SKIP; or `no_pr_path` with no actionable alternate channel; or policy forbids the change type | Do not invest; pick the next queue item |

When `no_pr_path` is present, read `feedback_channel` in evidence and map it to **issue_comment_patch** or **security_report** â€” never default to **pr**.

### Gate 3: Hunt loop (perf)

Wall time is usually **N Ã— worth_check**, not one slow check. Prefer a narrow funnel:

1. `npx gitworthy doctor --json` once per machine/session if auth or rate limits are unsure.
2. Prefer **`npx gitworthy hunt owner/repo --json`** or **`npx gitworthy hunt openclaw --json`** (org) â€” policy gate â†’ scan â†’ filter â†’ â‰¤3 serial worth_checks in one call.
3. Or manual funnel: `policy` â†’ `scan`/`org` â†’ prefilter â†’ â‰¤3â€“5 serial `worth_check`.
4. **Prefilter** (also applied by `hunt` by default):
   - skip `likely_land_only: true` / assigned / `soft_ask: true` / thin descriptions unless hunting those
   - skip known linked-PR-open / land-only
   - prefer higher `quality_score` (then `fit_score` if you pass `--skill-profile`) and clear repro
   - check `gitworthy ledger show owner/repo#N --json` to avoid re-checking recent hits
5. If hunting manually: run **`worth_check` on at most 3â€“5** survivors, **serial per repo** (concurrency 1â€“2).
6. Optional: `related` for lexical sibling clusters; `--probe-template changelog` (etc.) for release probes; `probes` to list templates.

Do **not** worth_check every scan row. `worth_check` auto-records to the local scout ledger. `hunt` returns no ACT/SKIP signals of its own â€” read each `hunt_candidate.worth_check`.

## Execute lane + Track O

After you select work:

1. `outcome record â€¦ --event selected --decision-id â€¦`
2. When a PR exists: `outcome record â€¦ --event pr_opened --pr-url â€¦ --decision-id â€¦`
3. After merge/close: `outcome reconcile` (dry-run), then `outcome reconcile --write` for clear terminals.
4. Doctor warns on Track O debt (`pr_opened` / `selected`+`pr_url` without a terminal).

Ambiguous maintainer closes stay in `needs_adjudication` â€” label with `outcome record` + `--close-reason`. Never invent frozen fixtures from reconcile.

## Commands

```sh
npx gitworthy check owner/repo#123 --json
```

If the project publishes an npm package, include it:

```sh
npx gitworthy check owner/repo#123 --npm-package package-name --json
```

`--npm-package` alone reports package release state; it does not prove an issue-specific fix shipped. For that, add `--probe-glob` / `--probe-contains`, or a named `--probe-template` (`changelog`, `readme`, `package-exports`, `dist-index`, `src-index`).

## Interpretation

- **ACT** means the completed deterministic checks did not find a blocking signal. ACT is a **queue candidate**, not permission to claim.
- **VERIFY** means a human must perform the named checks before investing or making any public claim. If `assigned` or `claim_required` is present, coordinate or claim before acting. If `needs_repro` is present, reproduce the failure first. If `linked_pr_closed` is present, read the prior attempt before retrying. If `no_pr_path` is present, do not plan a PR unless the stated feedback channel says otherwise.
- **SKIP** means the tool found a strong signal that the work is already handled, in flight, linked to an open PR, released, or duplicated.
- `disposition` refines hunt action without changing the verdict: `land_only` = review/land the open linked PR (do not open a parallel fix); `greenfield` = start work; `crowded` = dense prior attempts; `claim_first` / `blocked` / `review` as named.
- Scan `likely_land_only` is a cheap prefilter only â€” still run `worth_check` before claiming.
- Read `timings_ms` and `perf` on `worth_check` when optimizing hunts (`clone_cached`, `file_list_cached`, `branch_tip_fetches`, short-circuit flags).

`scan` / `org_scan` rank tracker candidates by `quality_score` (repro clarity, labels, staleness, soft asks, assignees). Higher scores are better triage starts; scan still does not vet contribution targetsâ€”always follow with `worth_check` on a **short** list.

Mandatory rule: never make a public claim from a VERIFY verdict without performing the named human checks.

Always read `checked`, `not_checked`, and the evidence URLs. The limitations are part of the result, not footnotes.

### Gate 4: Apply-lane revalidation at claim/implement time

When the user says **"take #N"** or you claim an issue for implementation, **re-run `worth_check` immediately** before forking:

```sh
npx gitworthy check owner/repo#123 --json
```

Scout results go stale. Linked PRs merge, issues get assigned, and branches land. Treat the fresh result as authoritative; abandon or downgrade if the verdict changed.

Record the target in the scout ledger when available (`gitworthy ledger record owner/repo#123`).

### Gate 5: ACT is not claimable without evidence review

Before claiming any ACT item, read:

1. **`worth_check.reasons`** â€” every sub-check signal and error
2. **`linked_work` sub-result** â€” all `evidence` entries, especially linked PRs
3. **`contrib_policy` sub-result** â€” path matrix inputs

**Closed unmerged PRs:** inspect every closed linked PR before claiming. Read why it closed; if the fix was rejected or incomplete, only proceed with a clearly different approach.

Never treat ACT as "clear to claim" from the verdict alone.

### Scout â†’ execute bridge

- **`scan` / `hunt` + `worth_check` produce a ranked ACT list.** That list is a **queue**, not finished work.
- **"Take #N"** means: record in ledger â†’ choose path from matrix â†’ re-`worth_check` â†’ fork â†’ repro on main â†’ implement â†’ review branch diff â†’ PR or issue comment per path.
- **Scout chats do not open PRs.** Execute chats do not re-scout without reading the ledger.
- Parallelize only across **claimed** issues (one worktree per claim).

### Verdict quick reference

| Verdict | Scout lane | Execute lane |
|---------|------------|--------------|
| ACT | Add to queue; still read linked_work evidence | Re-check at claim; then fork/repro if still ACT |
| VERIFY | List with named human checks; do not rank as top pick | Perform checks first; do not fork until resolved |
| SKIP | Drop from queue | Abandon claim if re-check flips to SKIP |

## Token note

For accurate `linked_work`, `GITHUB_TOKEN` must see issue **timeline cross-referenced** events (classic PAT, or fine-grained with **Issues: Read**). Weak tokens omit cross-links and under-count prior PRs; gitworthy falls back to title/body search and warns in `not_checked`. Prefer the same token quality you use with `gh` for hunts. Run `gitworthy doctor` to probe timeline visibility and rate remaining.

## Privacy and security

- Prefer public repositories. Do not capture or export private repository content by default.
- Never place tokens in config files, fixtures, or chat logs.
- Security vulnerabilities in gitworthy itself: follow `SECURITY.md` (private disclosure).

