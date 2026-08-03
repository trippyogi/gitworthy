# 1.0 release readiness

Maintainer checklist derived from GW-038. This is not a substitute for the issue — it tracks what is still open after engineering slices.

## Decision quality

| Gate | Status |
|---|---|
| ≥30 frozen adjudicated cases (0.6 floor) | Met (`eval/frozen/INVENTORY.md`) |
| ≥60 / 75 / 125 / 150 corpus milestones | Open — needs human adjudication + promotion |
| ≥30 hard-SKIP adjudicated | Open |
| ≥30 investigated ACT | Open (10 ACT in frozen today) |
| Zero false hard SKIP in release corpus | Ongoing |
| ACT precision ≥90% on investigated ACT | Measured by `pnpm eval:report` |

## Product / docs

| Gate | Status |
|---|---|
| Doctor capability matrix | Shipped (GW-031 slice) |
| Human CLI + quiet/verbose | Shipped (GW-030 slice) |
| MCP descriptions/annotations/structuredContent | Shipped (GW-032) |
| Beta docs set | Shipped (GW-033 slice) |
| External beta users (3–5) | **Human** |
| Multi-host + multi-OS dogfood | **Human** |

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
