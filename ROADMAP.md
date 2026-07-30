# Roadmap

Path from the current OSS preflight tool to a trustworthy local-first **1.0**, then optional hosted layers.

Source of truth for implementation detail: the v1 productization build specification. This file is the public summary.

## Product decision

**1.0 is:** a trusted local decision engine (CLI + MCP) that answers: *Should I invest the next unit of work in this issue now?* with `ACT` / `VERIFY` / `SKIP`, explicit evidence, and explicit limitations.

**1.0 is not:** hosted SaaS, team billing, private-repo requirement, autonomous implementation agents, LLM verdicts, always-on telemetry, or background daemons.

The core stays **MIT-licensed and open source**. Paid value after 1.0 should come from coordination, shared history, private data, and hosted reliability — not from hiding checks.

## Release ladder

| Release | Outcome | Audience |
|---|---|---|
| `0.3.10` | Reproducible baseline, CI, package/release discipline, clean backlog | Maintainer |
| `0.4.0` | Safe hard decisions, versioned contracts, bounded hostile-input handling | Maintainer |
| `0.5.0` | Durable runs, decisions, outcomes, captures, config, briefs | Maintainer |
| `0.6.0` | Frozen adjudicated eval separate from live drift | Maintainer + reviewers |
| `0.7.0` | Strong hunt funnel and resumable runs | Design partners |
| `0.8.0` | Onboarding, doctor, CLI/MCP UX, public beta support | First public users |
| `0.9.0` | Contract freeze, migration proof, soak/security/cross-platform RC | Beta + reviewers |
| `1.0.0` | Stable trusted local decision engine | GA |

## Non-negotiable invariants

1. Heuristic evidence must never independently create `SKIP`.
2. Hard `SKIP` requires definitive evidence.
3. Failed mandatory checks cap at `VERIFY`.
4. Every result includes meaningful `checked` and `not_checked`.
5. Target repositories and packages are hostile input (no code execution; budgets/timeouts).
6. No telemetry required for calibration; outcome data is local by default.
7. Tokens never land in config, captures, logs, or exports.

## Work item IDs

Roadmap tickets use local IDs `GW-001` … `GW-038` (see GitHub milestones). Do not reorder trust work ahead of discovery features: complete the `0.4.0` trust boundary before broad hunt UX, and invite external users only after durable outcomes (`0.5`) and frozen eval (`0.6`).

## Post-1.0 (not started)

Likely layers after the local engine is proven:

1. Hosted scheduled hunts / watchlists
2. Shared team ledger and outcome graph
3. Private-repository support and org policy
4. API access for coding-agent dispatch
5. Notifications and maintainer-side queues
6. Aggregate benchmarks (advisory semantic retrieval never as an opaque blocker)

## How to contribute along the roadmap

See `CONTRIBUTING.md`. Prefer milestone issues over drive-by features. Security reports: `SECURITY.md`.
