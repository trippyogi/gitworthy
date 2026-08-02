import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authorizeMcpRequest, hostHeaderAllowed } from './auth.js';
import { createMcpServer } from './server.js';

export type HttpMcpHandlerOptions = {
  /** Bearer token expected in Authorization. When unset, requests are allowed (loopback-only use). */
  token?: string;
  /** Optional Host allow-list (hostname or host:port). */
  allowedHosts?: string[];
  /** MCP path. Default `/mcp`. */
  path?: string;
  /** When true (default for serverless), no session tracking. */
  stateless?: boolean;
  /** Prefer JSON responses (better behind many proxies). Default true for stateless. */
  enableJsonResponse?: boolean;
};

function normalizePath(path: string): string {
  if (!path.startsWith('/')) return `/${path}`;
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function jsonRpcError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: status === 401 ? -32001 : -32000, message },
      id: null
    }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        ...(status === 401 ? { 'www-authenticate': 'Bearer realm="gitworthy-mcp"' } : {})
      }
    }
  );
}

/**
 * Handle one Streamable HTTP MCP request using Web Standard APIs.
 * Suitable for Vercel / Workers / any Fetch-compatible runtime.
 */
export async function handleMcpHttpRequest(
  request: Request,
  options: HttpMcpHandlerOptions = {}
): Promise<Response> {
  const path = normalizePath(options.path ?? '/mcp');
  const url = new URL(request.url);

  if (url.pathname === '/healthz' || url.pathname === '/health') {
    return new Response(JSON.stringify({ ok: true, service: 'gitworthy-mcp' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  if (url.pathname !== path) {
    return new Response('Not Found', { status: 404 });
  }

  if (!hostHeaderAllowed({ hostHeader: request.headers.get('host'), allowedHosts: options.allowedHosts })) {
    return jsonRpcError(403, 'Forbidden: Host header not allowed.');
  }

  const auth = authorizeMcpRequest({
    authorizationHeader: request.headers.get('authorization'),
    expectedToken: options.token
  });
  if (!auth.ok) {
    return jsonRpcError(auth.status, auth.message);
  }

  const method = request.method.toUpperCase();
  if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { allow: 'GET, POST, DELETE' }
    });
  }

  const stateless = options.stateless !== false;
  const enableJsonResponse = options.enableJsonResponse ?? stateless;

  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: stateless ? undefined : () => randomUUID(),
    enableJsonResponse
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    // Stateless/serverless: tear down after each request.
    if (stateless) {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }
}

/**
 * Node-friendly alias that wraps StreamableHTTPServerTransport for tests that
 * prefer the Node adapter (same protocol).
 */
export async function createStatelessNodeTransport(): Promise<{
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
  close: () => Promise<void>;
}> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  await server.connect(transport);
  return {
    transport,
    server,
    close: async () => {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}
