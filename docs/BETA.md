# Design-partner beta (GW-034)

**Goal:** 3–5 people complete a real MCP-first scout loop and send back evidence — not a survey.

**Sequencing:** beta runs **now** on a pinned build. Corpus grows from their hunts and your dogfood. Do not wait for 150 frozen cases first.

**Pitch:** Gitworthy’s core is **deterministic** — no model in the verdict path — so ACT/VERIFY/SKIP can be frozen-eval’d. That is the differentiator vs preflight tools that are model wrappers.

## Pin

```sh
npx -y gitworthy@0.4.1 doctor --json
# or after the next RC tag is cut:
# npx -y gitworthy@<rc> …
```

Record the exact version in every feedback note.

## What we ask each partner to do (≤30 minutes)

1. `doctor --json` (paste redacted capabilities summary, no tokens).
2. One bounded hunt on a **suggested** repo (below), `--json` or MCP equivalent.
3. One `worth_check` / check on a candidate they might actually touch.
4. Optional: `outcome record … --event selected` (or abandoned) with a one-line note.
5. Send back: version, host (Cursor / other), redacted JSON or capture id, and anything that felt wrong.

MCP setup: README + [`MCP.md`](./MCP.md) + [`AGENT_WORKFLOW.md`](./AGENT_WORKFLOW.md).

## Suggested targets (spread these)

**Do not** all hunt the same two high-visibility repos where the maintainer has live applications. Avoid concentrating on OpenClaw / hermes-agent during beta.

Prefer a mix:

| Repo (examples) | Why |
|---|---|
| `sindresorhus/ky` | Small TS HTTP lib; readable issues |
| `colinhacks/zod` | Popular schema lib; many good-first patterns |
| `vitest-dev/vitest` | Tooling issues; clear repro culture |
| `expressjs/express` | Classic Node; policy/CLA paths |
| A repo **they already contribute to** | Highest signal |

Ask each partner for a **different** primary target. Put their choice in the feedback note.

## Where to recruit (priority order)

1. **Named power users you already have rapport with** — lead with a technical question or shared failure mode, not a transactional “please beta test.”
2. **Rooms of people already triaging OSS contributions with agents** (contribution / clawtributor-style Discords). Offer a pinned version + this doc.
3. **In-person** (meetups / AICamp-style): five-minute live `doctor` → `hunt` → show SKIP/land_only beats a Discord DM.
4. **People who lost the same race** (superseded PRs in public captures) — invite them to re-check a *different* target with Gitworthy before the next attempt.

Aim for **two MCP hosts** represented (e.g. Cursor + one other) and ideally **two OSes**.

## What success looks like

- ≥3 partners complete the loop above.
- Every correctness/safety surprise becomes a **capture → adjudicated frozen case** (or an explicit accepted risk).
- No unresolved P0/P1 on verdict honesty, secrets, or install.

## Maintainer checklist (this week)

- [ ] Cut or confirm pin (`0.4.1` or `0.5-rc`).
- [ ] Send ≤5 personal invites with this doc + one suggested repo each.
- [ ] Collect outcomes into captures / issues.
- [ ] Promote only adjudicated regressions; keep [`CORPUS.md`](./CORPUS.md) taxonomy honest.

## Out of scope for beta

- Model-in-the-loop relation verdicts (parked; stay deterministic for 1.0).
- Private-repo captures by default.
- Asking partners to generate load on a single org you care about politically.
