# Candidate ranking contract (GW-026)

`ranking_version` is a public machine contract. Formula changes must bump the version.

## Version `1`

Final score:

```
rank_score =
  quality_norm * w_quality
  + fit_score  * w_fit          # omitted when skill_profile is absent; quality absorbs fit weight
  + availability_hint_score * w_availability
```

Defaults (normalized to sum 1):

| Component | Weight | Source |
|---|---|---|
| quality | 0.55 | tracker quality (`quality_score` / 100) |
| fit | 0.25 | optional skill profile (`fit_score` 0–1) |
| availability | 0.20 | assignees / land-only / soft-ask hints |

### Availability hints

Start at `1.0`, then subtract:

- assigned: −0.45
- likely_land_only: −0.35
- soft_ask: −0.15

Clamped to `[0, 1]`. These are **ranking heuristics**, not hard filters. Hard filters (label, keyword, since, PR-row exclusion) run before ranking.

### Tie-breakers

1. higher `rank_score`
2. newer `updated_at`
3. lower issue number

### Output fields

Every ranked candidate exposes:

- `quality_score`, `quality_reasons`
- `fit_score` / `fit_reasons` when a skill profile applies (else not applicable)
- `availability_hint_score`
- `rank_score`
- `ranking_version`

`--explain-ranking` / `explain_ranking: true` adds per-candidate component lines plus a `ranking_explain` evidence row.

### Non-goals

Ranking never changes ACT / VERIFY / SKIP policy. A low score alone cannot remove a candidate unless the user set an explicit filter.
