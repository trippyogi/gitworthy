# Performance counters and budgets (GW-029)

`counters_version` is part of the public metrics contract. Changes that rename or reinterpret fields must bump it.

## Counters (`metrics`)

| Field | Meaning |
|---|---|
| `duration_ms` | Wall time for the active run budget |
| `github_requests` | Networked GitHub/raw HTTP requests (cache hits excluded) |
| `github_retries` | Transient HTTP retries |
| `cache_hits` | TTL / in-flight coalesced GitHub responses |
| `git_commands` | Git subprocess invocations (when instrumented) |
| `bytes_read` | Bytes counted from instrumented readers |
| `pages_fetched` | Discovery issue pages fetched |
| `candidates_considered` | Provider rows considered during discovery |
| `budget_exhausted` | Soft/hard budget hit |
| `budget_reasons` | Human-readable exhaustion reasons |

## Soft budgets

`RunBudget` supports optional caps:

- `maxGithubRequests`
- `maxElapsedMs`

Exhaustion is recorded on the run counters. Primary commands preserve completed work and surface partial status where discovery/hunt already support it.

## Offline benchmarks

```bash
pnpm bench:frozen
```

Runs deterministic offline fixture microbenchmarks (no live network). CI may gate on large regressions; live latency remains advisory.
