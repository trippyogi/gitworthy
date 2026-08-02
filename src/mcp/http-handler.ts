import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authorizeMcpRequest, hostHeaderAllowed } from './auth.js';
import { createMcpServer } from './server.js';

export type HttpMcpHandlerOptions = {
  /** Bearer token expected in Authorization. Required unless allowUnauthenticated. */
  token?: string;
  /**
   * Explicit opt-in for tokenless mode (loopback Node server only).
   * Shared/serverless handlers must leave this false/undefined (fail closed).
   */
  allowUnauthenticated?: boolean;
  /** Optional Host allow-list (hostname or host:port). */
  allowedHosts?: string[];
  /** MCP path. Default `/mcp`. */
  path?: string;
  /**
   * Stateless mode only for this shared handler (serverless-safe).
   * Stateful sessions are owned by `startHttpMcpServer`.
   */
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
    expectedToken: options.token,
    allowUnauthenticated: options.allowUnauthenticated === true
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

  // Shared handler is always stateless; long-lived sessions live in http-server.ts.
  const enableJsonResponse = options.enableJsonResponse ?? true;

  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
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
