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
4. Execute lane: `outcome record … --event selected`, then `pr_opened --pr-url …` when a PR exists. After merges/closes: `outcome reconcile` (then `--write`).
5. Wrong verdict? `worth_check --capture` and send the capture id (or redacted JSON).
6. Send back: version, host (Cursor / other), redacted JSON or capture id, and anything that felt wrong.

MCP setup: README + [`MCP.md`](./MCP.md) + [`AGENT_WORKFLOW.md`](./AGENT_WORKFLOW.md). Corpus growth rules: [`CORPUS_CONTRIB.md`](./CORPUS_CONTRIB.md).

## Suggested targets (spread these)

**Do not** all hunt the same two high-visibility repos where the maintainer has live applications. Avoid concentrating on OpenClaw / hermes-agent during beta.

Prefer a mix:

| Partner slot | Suggested primary | Why |
|---|---|---|
| 1 | `sindresorhus/ky` | Small TS HTTP lib; readable issues |
| 2 | `colinhacks/zod` | Popular schema lib; many good-first patterns |
| 3 | `vitest-dev/vitest` | Tooling issues; clear repro culture |
| 4 | `expressjs/express` | Classic Node; policy/CLA paths |
| 5 | A repo **they already contribute to** | Highest signal |

Ask each partner for a **different** primary target. Put their choice in the feedback note.

## Where to recruit (priority order)

1. **Named power users you already have rapport with** — lead with a technical question or shared failure mode, not a transactional “please beta test.”
2. **Rooms of people already triaging OSS contributions with agents** (contribution / clawtributor-style Discords). Offer a pinned version + this doc.
3. **In-person** (meetups / AICamp-style): five-minute live `doctor` → `hunt` → show SKIP/land_only beats a Discord DM.
4. **People who lost the same race** (superseded PRs in public captures) — invite them to re-check a *different* target with Gitworthy before the next attempt.

Aim for **two MCP hosts** represented (e.g. Cursor + one other) and ideally **two OSes**.

## Ready-to-send invites

Copy, personalize the bracketed bits, send ≤5 this week. One suggested repo per person.

### A — Warm technical peer (Discord / DM)

> Hey [name] — you mentioned [race / false SKIP / wasted PR] on [context]. I’m dogfooding **Gitworthy** (deterministic ACT/VERIFY/SKIP scout, no model in the verdict path) and need 3–5 people to burn ~20–30 min on a pinned build.
>
> Pin: `npx -y gitworthy@0.4.1 doctor --json`
> Doc: [link to this BETA.md]
> Suggested first hunt target (yours alone): `[slot repo from table]`
>
> Loop: doctor → one hunt → one worth_check on something you’d actually touch → reply with version + host + redacted JSON (or a capture id). Wrong answers are the useful ones.

### B — Clawtributor / contribution-room post

> Looking for a few people who already triage OSS with agents to try **gitworthy@0.4.1** (MCP-first). Pitch: deterministic preflight — frozen-eval able ACT/SKIP — not another LLM wrapper.
>
> 30-min loop in the beta doc: doctor → hunt → worth_check → optional outcome record.
> Please pick a **different** public repo than the ones others claim in-thread (avoid piling onto the same two high-traffic agent repos).
>
> Feedback = version + host + redacted JSON/capture. Surprises > praise.

### C — Race-loser follow-up

> Saw your [PR / attempt] get overtaken on [issue]. Before the next try on a **different** target, want a 20-min Gitworthy pass (`gitworthy@0.4.1`) so SKIP/land_only shows up before you write the patch?
>
> Happy to walk the MCP install if useful — otherwise the beta doc has the loop.

### D — In-person (30-second ask)

> “Got five minutes? `doctor` then one hunt — I’ll show a hard SKIP vs a greenfield ACT on a public issue.”

## Maintainer checklist (this week)

- [ ] Cut or confirm pin (`0.4.1` or `0.5-rc`).
- [ ] Assign each invitee a unique primary repo (table above).
- [ ] Send ≤5 personal invites (templates A–C).
- [ ] Collect outcomes into captures / issues (`gitworthy capture list --json`).
- [ ] Promote only adjudicated regressions; keep [`CORPUS.md`](./CORPUS.md) taxonomy honest.
- [ ] Do **not** farm synthetic verdict ground truth for live promote candidates without captures.

## What success looks like

- ≥3 partners complete the loop above.
- Every correctness/safety surprise becomes a **capture → adjudicated frozen case** (or an explicit accepted risk).
- No unresolved P0/P1 on verdict honesty, secrets, or install.

## Out of scope for beta

- Model-in-the-loop relation verdicts (parked; stay deterministic for 1.0).
- Private-repo captures by default.
- Asking partners to generate load on a single org you care about politically.
