# gitworthy skill

Use gitworthy before spending time on an external repository issue or feature request.

## Mandatory OSS contribution loop

Never invert this order. Scout and execute are separate lanes; execute never skips gates.

```
1. contrib_policy   → 2. scan (optional)  → 3. worth_check
        ↓
4. ledger claim ("take #N")  → 5. worth_check again (apply-lane revalidation)
        ↓
6. fork  → 7. repro  → 8. implement  → 9. Bugbot  → 10. PR or comment
```

### Gate 1: `contrib_policy` before fork, implement, or PR

Run contribution policy **before** forking, cloning for implementation, or opening a PR:

```sh
npx gitworthy policy owner/repo --json
```

Or use `npx gitworthy scan owner/repo --json` only as tracker triage; follow its policy reminder when no cached policy exists.

**Do not fork or implement until policy is read and the contribution path is chosen** (see path matrix below). OpenRouter-class failures happen when policy runs after the PR is already open.

### Gate 2: Path matrix from policy signals

Pick exactly one contribution path from `contrib_policy` evidence before investing:

| Path | When to use | Deliverable |
|------|-------------|-------------|
| **pr** | Default when policy allows PRs; no `no_pr_path`; no security-only channel | Fork → branch → PR |
| **issue_comment_patch** | `issue_first_or_alignment` in policy; or `no_pr_path` with a forum/discussion/issue feedback channel | Repro + minimal patch or steps in an issue comment (or linked discussion) |
| **security_report** | `SECURITY.md` or policy excerpt requires private disclosure (HackerOne, security@, coordinated disclosure) | Report via stated channel; do not open a public PR for the vulnerability |
| **skip** | `worth_check` SKIP; or `no_pr_path` with no actionable alternate channel; or policy forbids the change type (`forbidden_pr_types`) | Do not invest; pick the next queue item |

When `no_pr_path` is present, read `feedback_channel` in evidence and map it to **issue_comment_patch** or **security_report** — never default to **pr**.

### Gate 3: `worth_check` at scout time

Run the composite check after policy:

```sh
npx gitworthy check owner/repo#123 --json
```

If the project publishes an npm package, include it:

```sh
npx gitworthy check owner/repo#123 --npm-package package-name --json
```

`--npm-package` alone reports package release state; it does not prove an issue-specific fix shipped. For that, add `--probe-glob` and `--probe-contains` so `release_gap` can search the published tarball.

Interpretation:

- **ACT** means the completed deterministic checks did not find a blocking signal. ACT is a **queue candidate**, not permission to claim.
- **VERIFY** means a human must perform the named checks before investing or making any public claim. If `assigned` is present, coordinate before acting. If `no_pr_path` is present, do not plan a PR unless the stated feedback channel says otherwise.
- **SKIP** means the tool found a strong signal that the work is already handled, in flight, linked to an open PR, released, or duplicated.

Mandatory rule: never make a public claim from a VERIFY verdict without performing the named human checks.

Always read `checked`, `not_checked`, and the evidence URLs. The limitations are part of the result, not footnotes.

### Gate 4: Apply-lane revalidation at claim/implement time

When the user says **"take #N"** or you claim an issue for implementation, **re-run `worth_check` immediately** before forking:

```sh
npx gitworthy check owner/repo#123 --json
```

Scout results go stale. Linked PRs merge, issues get assigned, and branches land. Treat the fresh result as authoritative; abandon or downgrade if verdict changed.

Record the claim in the scout ledger when available (`gitworthy ledger claim owner/repo#123`).

### Gate 5: ACT is not claimable without evidence review

Before claiming any ACT item, read:

1. **`worth_check.reasons`** — every sub-check signal and error
2. **`linked_work` sub-result** — all `evidence` entries, especially `kind: linked_pr`
3. **`contrib_policy` sub-result** — path matrix inputs

**Closed unmerged PRs:** `linked_work` may list PRs with `state: closed` and `merged: false` in evidence without a blocking signal (or with `linked_pr_closed` → VERIFY when that signal is present). **Inspect every closed linked PR before claiming.** Read why it closed; if the fix was rejected or incomplete, only proceed with a clearly different approach.

Never treat ACT as "clear to claim" from the verdict alone.

### Scout → execute bridge

- **`scan` + `worth_check` produce a ranked ACT list.** That list is a **queue**, not finished work.
- **"Take #N"** means: claim in ledger → choose path from matrix → re-`worth_check` → fork → repro on main → implement → Bugbot on branch diff → PR or issue comment per path.
- **Scout chats do not open PRs.** Execute chats do not re-scout without reading the ledger.
- Parallelize only across **claimed** issues (one worktree per claim).

### Verdict quick reference

| Verdict | Scout lane | Execute lane |
|---------|------------|--------------|
| ACT | Add to queue; still read linked_work evidence | Re-check at claim; then fork/repro if still ACT |
| VERIFY | List with named human checks; do not rank as top pick | Perform checks first; do not fork until resolved |
| SKIP | Drop from queue | Abandon claim if re-check flips to SKIP |
