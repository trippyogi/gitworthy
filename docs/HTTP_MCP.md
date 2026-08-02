# Streamable HTTP MCP

Gitworthy supports two MCP transports:

| Transport | Command | Use when |
|---|---|---|
| **stdio** (default) | `gitworthy mcp` / `npx -y gitworthy@latest mcp` | Local desktop IDE, agent VM with Node |
| **Streamable HTTP** | `gitworthy mcp --http` or a hosted `/mcp` URL | Cursor Cloud Agents, mobile/iPad, remote hosts |

HTTP MCP is the remote interface. It is not a multi-tenant SaaS product: you run or deploy the same open-source engine and protect it with a bearer token.

## Local HTTP server

```sh
export GITWORTHY_MCP_TOKEN="$(openssl rand -hex 32)"
export GITHUB_TOKEN="github_pat_..."
gitworthy mcp --http --host 127.0.0.1 --port 8787
```

Useful flags:

- `--host` — bind address (default `127.0.0.1`, or `GITWORTHY_MCP_HOST`)
- `--port` — listen port (default `8787`, or `GITWORTHY_MCP_PORT`)
- `--path` — MCP path (default `/mcp`, or `GITWORTHY_MCP_PATH`)
- `--stateless` — no session map; preferred behind serverless proxies

Bind policy:

- Loopback (`127.0.0.1`, `localhost`, `::1`) may start without a token for local dev.
  Tokenless loopback still enforces a localhost **Host allow-list** (DNS-rebinding protection).
- Any non-loopback bind (`0.0.0.0`, public host) **refuses to start** without `GITWORTHY_MCP_TOKEN`.
- Shared/serverless handlers **fail closed** without a token (no unauthenticated mode).
- When a token is configured, every MCP request must send:

  `Authorization: Bearer <GITWORTHY_MCP_TOKEN>`

Optional Host allow-list: `GITWORTHY_MCP_ALLOWED_HOSTS=mcp.example.com,localhost`.

Health check: `GET /healthz`.

## Cursor Cloud Agents / mobile

Add a custom HTTP MCP server in [cursor.com/agents](https://cursor.com/agents) (personal) or **Dashboard → Integrations & MCP** (team):

```json
{
  "mcpServers": {
    "gitworthy": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:GITWORTHY_MCP_TOKEN}"
      }
    }
  }
}
```

Notes:

- Cloud Agents recommend **HTTP** over stdio so credentials stay out of the agent VM.
- Use type `http` / URL-based config (not legacy SSE / `mcp-remote`).
- Keep `GITHUB_TOKEN` on the **server** environment, not in the client headers, unless you intentionally forward it.

## Deploy on Vercel

1. Expose `api/mcp.ts` (thin re-export of `src/mcp/vercel-handler.ts` for Vercel bundling).
2. Set project env:
   - `GITWORTHY_MCP_TOKEN` (required — handler fails closed without it)
   - `GITHUB_TOKEN` (recommended)
   - optional `GITWORTHY_MCP_ALLOWED_HOSTS`
   - optional `GITWORTHY_MCP_PATH` (defaults to the invoked URL path, e.g. `/api/mcp`)
3. Point Cloud Agents at `https://<deployment>/api/mcp`.

The serverless handler is **stateless** Streamable HTTP with JSON responses. Ephemeral serverless disks are not a durable outcome store.

## Security

- Treat a public MCP URL as a hostile-network surface.
- Rotate `GITWORTHY_MCP_TOKEN` if it leaks.
- Never put GitHub tokens in config files, captures, or MCP logs.
- Prefer short-lived deploy URLs or network allow-lists for early betas.

See `SECURITY.md`.
