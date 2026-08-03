# 1.0 release readiness

Maintainer checklist derived from GW-038. This is not a substitute for the issue — it tracks what is still open after engineering slices.

## Sequencing (product)

1. **GW-034 beta now** on a pinned build — see [`BETA.md`](./BETA.md).
2. Grow frozen corpus **from beta + dogfood** (wrong ACT / false SKIP / surprising VERIFY).
3. Mechanism packs (contention fixtures, etc.) are secondary coverage.
4. Do not quintuple mechanism-only cases hoping precision improves — see [`CORPUS.md`](./CORPUS.md).

## Decision quality

| Gate | Status |
|---|---|
| ≥30 frozen cases, suite green | Met — **30/30 pass** today (not a 12-failure corpus) |
| Verdict-scored precision denominator | Thin (**5** worth_check cases) — grow via beta |
| ≥60 / 75 / 125 / 150 volume milestones | Open — prefer beta-sourced promotions |
| ≥30 hard-SKIP adjudicated (verdict-scored) | Open |
| ≥30 investigated ACT (verdict-scored) | Open (1 ACT in precision math today) |
| Zero false hard SKIP | Met on current verdict-scored set |
| ACT precision ≥90% @ 1.0 | Gate once denominator is large enough |

## Real-usage / beta

| Gate | Status |
|---|---|
| Design-partner beta (3–5) | **Run now** — [`BETA.md`](./BETA.md) |
| Docs set for public beta | Shipped (GW-033 slice) |
| Multi-host + multi-OS dogfood | Via beta + CI OS smoke matrix |

## Contracts / reliability

| Gate | Status |
|---|---|
| `1.0-draft.1` → stable freeze | Open (GW-035; after beta) |
| Compatibility suite | Partial (`docs/COMPATIBILITY.md` + migrate/legacy tests) |
| Hunt cancel + partial resume | Shipped (SIGINT / AbortSignal) |
| Cross-platform / soak / fuzz / mutation | Partial (OS package-smoke matrix; seeded input fuzz; policy mutation guards) |
| RC install / upgrade / rollback | Partial (`pnpm test:upgrade` published→packed→rollback) |

## Honest note

Engineering can clear local gates (docs, MCP, doctor, cancel, CI). **1.0 publish still requires maintainer adjudication growth, external beta, and final audit sign-off.** Prefer cutting `0.8.0` / `0.9.0` RCs as those slices land rather than jumping straight to `1.0.0`.
