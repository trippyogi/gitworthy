# Agent Plugins (v1)

Gitworthy ships as an [Agent Plugins](https://agent-plugins.org/) v1.0.0 package: portable **Agent Skill** + **MCP server** in one directory so compatible clients (Cursor, VS Code, Copilot, Codex, …) can load the same bundle.

This is packaging/interop on top of the existing engine — not a new protocol.

## Layout

```text
gitworthy/
├── plugin.json                 # identity (Agent Plugins manifest)
├── mcp.json                    # stdio MCP launch (no secrets)
├── skills/gitworthy/SKILL.md   # canonical Agent Skill (YAML frontmatter)
├── SKILL.md                    # compatibility mirror (body only; CI-synced)
└── dist/cli/index.js           # MCP entry via mcp.json
```

## Install / load

Clients that support Agent Plugins discover `plugin.json`, load `skills/`, and connect MCP from `mcp.json`.

`mcp.json` launches the bundled binary:

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["${PLUGIN_ROOT}/dist/cli/index.js", "mcp"]
}
```

Provide `GITHUB_TOKEN` / `GH_TOKEN` in the **client environment** (or host secret store). Agent Plugins forbids embedding credentials in `mcp.json` `env` / `headers`.

Manual stdio (without a plugin client) remains:

```sh
npx -y gitworthy@0.4.1 mcp
```

HTTP / Cloud Agents: see [`HTTP_MCP.md`](./HTTP_MCP.md) — keep bearer tokens out of portable manifests.

## Skill source of truth

- Edit **`skills/gitworthy/SKILL.md`** (includes frontmatter).
- Sync the root mirror: `pnpm agent-plugins:check -- --write`
- CI / `pnpm check` runs `pnpm agent-plugins:check` (verify only).

## Version sync

`plugin.json` `version` must match `package.json` (enforced by `pnpm release:verify` and `agent-plugins:check`).
