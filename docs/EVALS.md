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
3. Build a provider fixture pack (or promote from a capture).
4. Land under `eval/frozen/cases/` + `eval/frozen/fixtures/`.

### Capture → promote (live candidates)

Live `promote_candidate` rows in `eval/live/cases.json` (`live-003`, `004`, `006`, `007`, `009`, `011`, `012`) need a real capture before freeze. Do **not** invent adjudications.

```sh
# After a surprising check/hunt with --capture:
gitworthy capture list --json
gitworthy capture show <capture_id> --json

gitworthy case promote <capture_id> \
  --verdict SKIP \
  --disposition land_only \
  --rationale 'human-reviewed: open closer still definitive' \
  --evidence-url 'https://github.com/owner/repo/issues/N' \
  --out ./eval/private/promotions/<id>.json
```

Then convert the promotion fixture into an offline provider pack, add a frozen case JSON + inventory row, and run `pnpm eval:frozen`. Mechanism-only packs (e.g. `contention`) grow path coverage; only `worth_check` rows expand the ACT/SKIP precision denominator — see [`CORPUS.md`](./CORPUS.md).

Before growing volume, read the taxonomy in [`CORPUS.md`](./CORPUS.md): suite pass rate ≠ verdict precision denominator.

Do not invent frozen cases without adjudication. Heuristic-only SKIP must not appear in the corpus.

## Track O (outcome calibration)

Separate from frozen. Joins a stored T0 decision to a later PR outcome for product insight — does **not** block CI or redefine 1.0. Spec: [`TRACK_O.md`](./TRACK_O.md).

## 1.0 corpus targets (release audit)

See GW-038: volume and precision gates (including ≥150 adjudicated frozen cases, hard-SKIP coverage, ACT precision). Current inventory is the floor for 0.6+; grow via promotion, not synthetic labels.
