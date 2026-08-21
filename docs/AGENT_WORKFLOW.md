# Agent workflow

Gitworthy is designed to sit inside a coding agent's workflow through MCP. It does not replace the host agent and it does not implement the issue itself.

The host agent owns the conversation, planning, repository operations, and execution. Gitworthy owns the bounded checks that answer whether a target is worth the next unit of work.

## Roles

| Component | Responsibility |
|---|---|
| **User** | Defines the goal, constraints, preferred technologies, and final selection. |
| **Host agent** | Calls Gitworthy, interprets results, maintains the queue, performs named verification, and executes selected work. Examples: Cursor, ChatGPT, Hermes, Claude Code, Codex, or OpenClaw. |
| **Gitworthy MCP** | Scans, filters, ranks, preflights, and returns structured evidence and limitations. Available over local stdio or Streamable HTTP (Cloud Agents / mobile); see `docs/HTTP_MCP.md`. |
| **Repository / GitHub** | Source of issue state, contribution policy, branches, linked work, releases, and current implementation. |

The intended relationship is:

```text
User goal
   │
   ▼
Host agent
   │
   ├── calls Gitworthy through MCP
   │
   ├── reads evidence and limitations
   │
   ├── builds a ranked candidate queue
   │
   └── executes only after fresh revalidation
```

## Two lanes

Gitworthy separates scouting from execution because these have different cost and safety requirements.

### Scout lane

Hunt scouts issues. Portfolio ranks contribution modes (issues + PRs) without replacing hunt or mutating verdicts.

```text
discover → filter → rank → preflight → shortlist
optional: portfolio (mode + dispatch_state)
```

The scout lane searches broadly but checks narrowly. Its output is a queue of candidates, not finished work and not permission to open pull requests.

### Execute lane

```text
select → record intent → recheck → reproduce → implement → review → submit
```

The execute lane starts only after a candidate is selected. It always rechecks current state because issue assignment, linked pull requests, branches, and maintainer policy can change after the original scout run.

## Preferred scout flow

### 1. Check readiness once per environment

Run `doctor` when authentication, timeline visibility, package version, cache access, or rate limits may be uncertain.

```sh
npx gitworthy doctor --json
```

An MCP host should call the equivalent doctor tool before a long scout session when capability is unknown.

### 2. Define a useful search scope

The host agent should establish:

- repository or organization;
- desired languages and topics;
- technologies to avoid;
- issue type or label preferences;
- maximum number of candidates worth fully checking.

A skill profile can improve fit ranking:

```text
languages=ts,go;topics=mcp,agents;avoid=swift
```

Skill fit is advisory. It ranks candidates; it does not create a verdict.

### 3. Prefer `hunt`

For normal agent scouting, use `hunt` rather than manually running an expensive preflight on every issue.

```sh
npx gitworthy hunt owner/repo --json
npx gitworthy hunt owner --max-checks 3 --json
```

`hunt` performs a bounded funnel:

```text
contribution policy
        ↓
scan repository or organization
        ↓
quality ranking + optional skill fit
        ↓
prefilter obvious weak / assigned / land-only rows
        ↓
worth_check only the best few candidates
        ↓
return individually preflighted candidates
```

Important: `hunt` does **not** produce one global `ACT`, `VERIFY`, or `SKIP` verdict. The host agent must read each candidate's `worth_check` result.

### 4. Inspect every candidate result

For each `hunt_candidate`, the host agent should inspect:

1. `worth_check.verdict`
2. `worth_check.disposition`
3. `worth_check.reasons`
4. `worth_check.evidence`
5. linked-work evidence and URLs
6. contribution-policy evidence
7. `checked`
8. `not_checked`
9. timing and performance fields when cost matters

Never rank from `verdict_summary` alone.

### 5. Build a ranked queue

The host agent—not Gitworthy—produces the final recommendation list.

A useful queue item contains:

```json
{
  "target": "owner/repo#123",
  "verdict": "ACT",
  "disposition": "greenfield",
  "quality_score": 0.86,
  "fit_score": 0.74,
  "why_it_ranks": [
    "clear reproduction steps",
    "matches TypeScript and MCP profile",
    "no linked implementation found"
  ],
  "required_before_execution": [
    "read contribution policy excerpt",
    "rerun worth_check at selection time"
  ]
}
```

The host agent may use user preferences and broader judgment to order ACT candidates. It must not hide unresolved VERIFY conditions or promote SKIP candidates.

## Verdict behavior

| Verdict | Scout lane | Execute lane |
|---|---|---|
| **ACT** | Add to the candidate queue after evidence review. | Recheck at selection time. Proceed only if the fresh result and contribution path still allow it. |
| **VERIFY** | Surface with the exact unresolved checks. Do not present as immediately claimable. | Perform the named verification before forking, implementing, or making public claims. |
| **SKIP** | Remove from the active queue. | Do not begin parallel work. Inspect cited work only when review or learning is useful. |

`ACT` means the completed checks found no blocking evidence. It is not a guarantee that the issue is claimable, reproducible, accepted by maintainers, or still unchanged.

## Dispositions

The verdict answers whether completed checks found a blocker. `disposition` refines the next action.

| Disposition | Meaning |
|---|---|
| `greenfield` | No blocking work found; candidate may enter the queue. |
| `land_only` | An open implementation already exists. Review or help land it; do not open a parallel fix. |
| `claim_first` | Coordinate or request assignment before implementation. |
| `blocked` | The contribution path is currently unavailable or prohibited. |
| `crowded` | Several prior attempts or related changes require careful inspection. |
| `review` | Existing or prior work must be read before deciding what to do. |

A disposition does not override the evidence or repository policy.

## Scout-to-execute handoff

When the user selects a candidate—for example, “take #2”—the host agent should perform this sequence.

### 1. Record intent

Use the local ledger or durable store available in the installed Gitworthy version so parallel agents and later sessions know the target is selected.

```sh
npx gitworthy ledger record owner/repo#123 --notes "selected for implementation"
```

On versions with durable outcome commands, record the corresponding selection event.

### 2. Recheck fresh state

```sh
npx gitworthy check owner/repo#123 --json
```

The fresh result is authoritative. Abandon or downgrade the candidate if:

- the verdict changes to `SKIP`;
- a new linked pull request appears;
- the issue becomes assigned;
- repository policy changes;
- a mandatory check fails;
- the contribution path is no longer available.

### 3. Choose the contribution path

Read contribution-policy evidence and select exactly one path:

| Path | Use when | Deliverable |
|---|---|---|
| **Pull request** | The repository accepts the change type and no issue-first gate blocks it. | Fork or branch, reproduce, implement, test, review, and open a PR. |
| **Issue comment / patch proposal** | Maintainers require alignment first or request proposals in issues/discussions. | Reproduction evidence, minimal patch, design, or implementation notes through the stated channel. |
| **Private security report** | Security policy requires private disclosure. | Report through the named private channel; do not expose the vulnerability publicly. |
| **Skip** | No acceptable contribution path exists or the fresh check blocks the target. | Stop and select the next candidate. |

### 4. Reproduce before modifying

For bug-shaped issues, reproduce against current default-branch state before coding. A stale issue description is not proof that the failure still exists.

### 5. Implement and review

The host agent may now use its normal coding workflow. Gitworthy does not replace:

- repository inspection;
- tests;
- implementation planning;
- code review;
- maintainer communication;
- pull request quality.

### 6. Record the outcome

Execute lane **must** close the loop so Track O can calibrate:

1. On take/claim: `outcome record … --event selected --decision-id …`
2. When the PR URL is known: `outcome record … --event pr_opened --pr-url https://github.com/…/pull/N --decision-id …`
3. Terminals: prefer `outcome reconcile` (dry-run, then `--write`) after merges/closes. Ambiguous closes stay in `needs_adjudication` — label those with `outcome record` + `--close-reason`.

Useful outcome events include:

- selected;
- claim requested;
- claim granted or denied;
- reproduction passed or failed;
- pull request opened;
- pull request merged;
- maintainer rejected;
- duplicate discovered;
- already fixed;
- abandoned.

```sh
gitworthy outcome reconcile --json
gitworthy outcome reconcile --write --json
```

Doctor warns when Track O debt > 0 (`pr_opened` / `selected`+`pr_url` without a terminal).

## When to call individual tools

`hunt` is the normal agent entry point, but individual tools remain useful.

| Tool | Use it when |
|---|---|
| `doctor` | Auth, permissions, version, rate limit, or local readiness is uncertain. |
| `policy` / `contrib_policy` | Before investing in an unfamiliar repository or selecting a contribution path. |
| `scan` | You want tracker candidates without full preflight. |
| `org_scan` | You want candidates across repositories in an organization or user account. |
| `hunt` | You want a bounded ranked funnel with preflight on the strongest few. |
| `worth_check` / `check` | You have a specific issue or are revalidating a selected target. |
| `linked_work` | Existing pull requests, commits, assignments, or prior attempts need focused inspection. |
| `related_cluster` | You need sibling issues or a possible issue family. |
| `release_gap` | A fix may be on `main` but absent from a published npm package. |
| `ledger` / store tools | You need memory across chats, agents, or sessions. |

Do not run `worth_check` on every row from a broad scan. Full checks have network and repository-inspection cost; `hunt` intentionally limits them.

## Recommended host-agent instruction

Use this as a starting policy for Cursor, ChatGPT, Hermes, or another MCP client:

> Use Gitworthy as the preflight and scouting layer for external repository work. For discovery, prefer `hunt` with a narrow scope and a maximum of three to five full checks. Read each candidate's individual `worth_check`, including disposition, evidence, `checked`, and `not_checked`. Build a ranked queue from ACT candidates; retain VERIFY candidates only with their named unresolved checks; remove SKIP candidates. ACT is not permission to implement. When I select a candidate, record intent, rerun `worth_check`, read contribution policy, choose the allowed path, reproduce on current main, and only then implement. Never make a public claim from a VERIFY result without completing the named verification.

## Example conversation

```text
User:
Find strong TypeScript or Go issues in open-source agent tooling.
Avoid mobile work. Give me the best three.

Host agent:
1. Calls Gitworthy doctor if environment readiness is unknown.
2. Calls hunt across the chosen repository or organization with a skill profile.
3. Reads every candidate's worth_check and evidence.
4. Returns a ranked queue:
   - #1 ACT / greenfield
   - #2 ACT / claim_first
   - #3 VERIFY / prior closed PR must be inspected
5. Explains why each ranks and what is unresolved.

User:
Take #1.

Host agent:
1. Records selection.
2. Reruns worth_check.
3. Reads contribution policy and linked work.
4. Reproduces the issue on current main.
5. Implements, tests, reviews, and submits through the allowed path.
6. Records the result.
```

## Non-goals

Gitworthy does not currently:

- autonomously implement every issue it finds;
- guarantee maintainers will accept a contribution;
- make heuristic evidence a hard blocker;
- replace reproduction or code review;
- make stale scout results safe to execute;
- require hosted infrastructure or telemetry.

The 1.0 target is a trustworthy, local-first decision engine that makes agent dispatch safer and more efficient.
