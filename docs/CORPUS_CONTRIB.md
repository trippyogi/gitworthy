# How to grow the corpus

Gitworthy has **two corpora**. Do not mix them.

| Track | What it is | Where it lives | Blocks 1.0 / CI? |
|---|---|---|---|
| **F (frozen)** | Adjudicated ACT/VERIFY/SKIP + offline replay | `eval/frozen/` in the **public** repo | **Yes** |
| **O (outcome)** | T0 verdict × T1 PR outcome join | Local `~/.gitworthy/store` | **No** |

Details: [`CORPUS.md`](./CORPUS.md), [`TRACK_O.md`](./TRACK_O.md), [`EVALS.md`](./EVALS.md).

## Personas

| Who | Setup | How you contribute |
|---|---|---|
| Solo dogfooder | npm or repo `dist` MCP + one machine store | Track O via `outcome reconcile`; promote surprises to Track F |
| Beta partner | Pin version in [`BETA.md`](./BETA.md) | Capture / redacted JSON → maintainer promotes |
| Multi-agent same box | Same `GITWORTHY_STORE_DIR` + same binary | Shared Track O automatically ([`TRACK_O.md`](./TRACK_O.md)) |
| Cross-machine team | Optional private store sync; public contrib = fixture PRs | **Never** commit Track O store into the public repo |

## Track O (local calibration)

1. Checks auto-write decisions (+ covariates on current builds).
2. Execute lane: `selected` → `pr_opened --pr-url` → later `outcome reconcile` (then `--write`).
3. Doctor surfaces `track_o_debt`.
4. Historical third-party PRs: `gitworthy outcome backfill --author=@me` (dry-run) then `--write`. Rows are **`reconstructed`** — never mix into snapshot-backed ACT precision.
5. Run **reconcile before backfill** for live open-lane debt.

```sh
gitworthy outcome reconcile --json
gitworthy outcome reconcile --write --json
gitworthy outcome backfill --author=@me --json
gitworthy outcome backfill --author=@me --write --json
```

## Track F (shared release corpus)

Partners and dogfooders do **not** edit `eval/frozen/` directly.

1. Surprising check → `worth_check --capture` (or hunt `--capture`).
2. Send **capture id** + short note (or redacted JSON) to the maintainer.
3. Maintainer path: adjudicate → `case promote` → provider pack → frozen case + inventory → `pnpm eval:frozen` → PR.

Checklist: [`BETA.md`](./BETA.md), [`EVALS.md`](./EVALS.md).

### What not to PR

- `~/.gitworthy/store` (decisions, outcomes, covariates)
- Partner captures without consent
- Auto-generated frozen fixtures without adjudication
- Invented `superseded` / `rejected` labels from reconcile `needs_adjudication` rows

## Agent packaging

Prefer installing Gitworthy so the agent gets both the MCP tools and the contribution skill (see README MCP / skill sections). Packaging does not replace capture → promote for Track F.
