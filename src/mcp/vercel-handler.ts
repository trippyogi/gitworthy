/**
 * Vercel / Fluid-compatible Streamable HTTP MCP entry.
 *
 * Deploy this package (or a thin wrapper) as a serverless function and point
 * Cloud Agents / mobile MCP config at the function URL with:
 *
 *   Authorization: Bearer $GITWORTHY_MCP_TOKEN
 *
 * Required env:
 * - GITWORTHY_MCP_TOKEN (bearer shared secret)
 * - GITHUB_TOKEN (GitHub API; optional but recommended)
 *
 * Optional:
 * - GITWORTHY_MCP_PATH (default `/mcp`)
 * - GITWORTHY_MCP_ALLOWED_HOSTS (comma-separated Host allow-list)
 */

import { handleMcpHttpRequest } from './http-handler.js';
import { MCP_TOKEN_ENV, resolveMcpToken } from './auth.js';

function allowedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.GITWORTHY_MCP_ALLOWED_HOSTS?.trim();
  if (!raw) return undefined;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export async function vercelMcpHandler(request: Request): Promise<Response> {
  const token = resolveMcpToken();
  if (!token) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: `Unauthorized: set ${MCP_TOKEN_ENV} for hosted MCP.`
        },
        id: null
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer realm="gitworthy-mcp"'
        }
      }
    );
  }

  const pathname = new URL(request.url).pathname;
  return handleMcpHttpRequest(request, {
    token,
    allowedHosts: allowedHostsFromEnv(),
    // Default to the invoked path so /api/mcp and custom rewrites both work.
    path: process.env.GITWORTHY_MCP_PATH?.trim() || pathname || '/mcp',
    enableJsonResponse: true
  });
}

export default vercelMcpHandler;
