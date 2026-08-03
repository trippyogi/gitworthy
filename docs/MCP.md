# MCP contract (GW-032)

Gitworthy’s primary agent surface is MCP (`gitworthy mcp` / HTTP). Hosts should prefer structured results over prose.

## Primary onboarding tools

| Tool | Role |
|---|---|
| `doctor` | Capability matrix before other work |
| `worth_check` | Single-issue ACT/VERIFY/SKIP |
| `hunt` | Bounded discovery + preflight |
| `brief` / `brief_show` | Decision brief from local store |
| `store_outcome_record` | Local outcome feedback loop |

Evidence tools (`scan`, `linked_work`, `contention`, …) support investigation; they are not substitutes for `worth_check` / `hunt` verdicts.

## Annotations

Each tool advertises MCP hints:

- `readOnlyHint` — no local store writes and no GitHub writes; tools that persist runs/decisions set this false even when GitHub stays read-only
- `idempotentHint` — safe to retry with the same args
- `openWorldHint` — may call GitHub/npm/network
- `destructiveHint` — local admin mutate (migrate/rebuild)

Hints are advisory. Input validation uses shared CLI contracts (`src/contracts/inputs.ts`).

## Results

Successful and failed tool calls return:

1. `content[0].text` — pretty-printed JSON (compatibility)
2. `structuredContent` — the same object for hosts that consume structured results
3. `isError: true` for operational/input failures (with `ErrorResult` body)

Do not parse human CLI output in agents.

## Stdio

Diagnostics must not write to stdout on the stdio transport. Use stderr for human progress when running the CLI; MCP stdio keeps stdout for protocol frames only.

## Self-test

```bash
pnpm mcp:self-test
```

Lists tools in-process and checks primary tools have descriptions + annotations.
