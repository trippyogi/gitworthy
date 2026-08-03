# Verdicts and dispositions

Gitworthy answers one question: **Should I invest the next unit of work in this issue now?**

Machine consumers must use structured JSON / MCP `structuredContent`. Human CLI text is not a contract.

## Verdicts

| Verdict | Meaning | Typical exit (CLI) |
|---|---|---|
| **ACT** | Completed mandatory checks found no hard blocker. Still re-check before public action. | `0` |
| **VERIFY** | Something needs human or follow-up verification before investing. | `10` |
| **SKIP** | Do not start parallel implementation now. | `20` |

Invalid invocation exits `2`. Operational failure exits `1`.

### Hard rules (non-negotiable)

1. **Heuristic evidence must never independently create `SKIP`.** Soft signals (crowding, weak text similarity, advisory skill fit) cap at `VERIFY`.
2. **Hard `SKIP` requires definitive evidence** (for example an open PR that explicitly closes the issue, or a merged closing PR already on main with no remaining gap you intend to fill).
3. **Failed mandatory checks cap at `VERIFY`** — never invent `SKIP` from a provider outage.
4. Every result includes meaningful **`checked`** and **`not_checked`**.
5. **`ACT` is a queue entry, not permission to ship.** Always re-run `worth_check` / `store_recheck` immediately before implementation.

## Dispositions

| Disposition | Meaning |
|---|---|
| `greenfield` | No definitive in-flight closer; may be worth implementing after recheck. |
| `land_only` | Help land an existing closing PR; do not open a parallel implementation. |
| `claim_first` | Contribution policy requires claim/assignment before code. |
| `blocked` | Policy or hard gate blocks PR path. |
| `crowded` | Multiple overlapping efforts; verify before investing. |
| `review` | Needs human judgment on evidence quality or scope. |

## Evidence strength

Findings carry `strength` and `effect`:

- **definitive** — can drive hard `SKIP` / `land_only` when policy allows.
- **strong** / **heuristic** — inform ranking and `VERIFY`; must not alone produce hard `SKIP`.

## Hunt has no global verdict

`hunt` is a triage orchestrator. Inspect each candidate’s nested `worth_check.verdict` / `disposition`. Partial hunts (`status: partial`, `partial_reason`, resume via `resume_run_id`) preserve completed candidates.

## Next actions

Structured `next_actions` (when present) are the machine-readable remediation. Prefer them over free-text summaries.

## Related

- Agent scout/execute loop: [`AGENT_WORKFLOW.md`](./AGENT_WORKFLOW.md)
- Ranking (advisory): [`RANKING.md`](./RANKING.md)
- Security boundaries: [`SECURITY_MODEL.md`](./SECURITY_MODEL.md)
