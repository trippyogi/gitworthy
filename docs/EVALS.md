# Evaluation

Gitworthy evaluation is split so release gates stay offline and reproducible.

Full detail: [`../eval/README.md`](../eval/README.md), [`../eval/METRICS.md`](../eval/METRICS.md), [`../eval/frozen/INVENTORY.md`](../eval/frozen/INVENTORY.md).

## Suites

| Suite | Network | Release blocking |
|---|---|---|
| **frozen** | Offline fixture replay | Yes |
| **live** | Public GitHub/npm/git | Advisory |
| **private** | Local captures (gitignored) | No |

```sh
pnpm eval:frozen
pnpm eval:report
pnpm eval:live      # needs token + network
```

## Promotion

1. Prefer **beta / dogfood captures** over solo fixture farming ([`BETA.md`](./BETA.md)).
2. Adjudicate ground truth (verdict, disposition, failure_mode, evidence URLs).
3. Build a provider fixture pack.
4. Land under `eval/frozen/cases/` + `eval/frozen/fixtures/`.

Before growing volume, read the taxonomy in [`CORPUS.md`](./CORPUS.md): suite pass rate ≠ verdict precision denominator.

Do not invent frozen cases without adjudication. Heuristic-only SKIP must not appear in the corpus.

## Track O (outcome calibration)

Separate from frozen. Joins a stored T0 decision to a later PR outcome for product insight — does **not** block CI or redefine 1.0. Spec: [`TRACK_O.md`](./TRACK_O.md).

## 1.0 corpus targets (release audit)

See GW-038: volume and precision gates (including ≥150 adjudicated frozen cases, hard-SKIP coverage, ACT precision). Current inventory is the floor for 0.6+; grow via promotion, not synthetic labels.
