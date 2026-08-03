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

1. Capture a public run (`--capture`).
2. Adjudicate ground truth (verdict, disposition, failure mode, evidence URLs).
3. Build a provider fixture pack.
4. Land under `eval/frozen/cases/` + `eval/frozen/fixtures/`.

Do not invent frozen cases without adjudication. Heuristic-only SKIP must not appear in the corpus.

## 1.0 corpus targets (release audit)

See GW-038: volume and precision gates (including ≥150 adjudicated frozen cases, hard-SKIP coverage, ACT precision). Current inventory is the floor for 0.6+; grow via promotion, not synthetic labels.
