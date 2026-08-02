import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_TOKEN_ENV,
  assertHttpBindAllowed,
  authorizationFromNodeRequest,
  authorizeMcpRequest,
  hostHeaderAllowed,
  isLoopbackHost,
  isPublicBindHost,
  resolveAllowedHosts,
  resolveMcpToken
} from './auth.js';
import { createMcpServer } from './server.js';
import { handleMcpHttpRequest } from './http-handler.js';

export type StartHttpMcpServerOptions = {
  host?: string;
  port?: number;
  path?: string;
  token?: string;
  /** Comma-separated or array Host allow-list. */
  allowedHosts?: string[] | string;
  /** Stateless mode (default false for long-running CLI). */
  stateless?: boolean;
  /** Prefer JSON responses. Defaults to true when stateless. */
  enableJsonResponse?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Override listen implementation for tests. */
  createServerImpl?: typeof createServer;
};

export type StartedHttpMcpServer = {
  host: string;
  port: number;
  path: string;
  url: string;
  tokenConfigured: boolean;
  tokenRequired: boolean;
  close: () => Promise<void>;
  server: Server;
};

function normalizePath(path: string): string {
  if (!path.startsWith('/')) return `/${path}`;
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function parseAllowedHosts(value: string[] | string | undefined, env: NodeJS.ProcessEnv): string[] | undefined {
  if (Array.isArray(value)) {
    const cleaned = value.map((item) => item.trim()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  const fromEnv = env.GITWORTHY_MCP_ALLOWED_HOSTS?.trim();
  if (fromEnv) return fromEnv.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(status === 401 ? { 'www-authenticate': 'Bearer realm="gitworthy-mcp"' } : {})
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function nodeRequestToWeb(req: IncomingMessage, body: unknown, listenHost: string, port: number): Request {
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : `${listenHost}:${port}`;
  const url = new URL(req.url ?? '/', `http://${hostHeader}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
    init.body = JSON.stringify(body);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return new Request(url, init);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    const existing = headers[key];
    if (existing === undefined) headers[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[key] = [existing, value];
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

export function resolveHttpMcpListenOptions(options: StartHttpMcpServerOptions = {}): {
  host: string;
  port: number;
  path: string;
  token?: string;
  allowedHosts?: string[];
  stateless: boolean;
  enableJsonResponse: boolean;
} {
  const env = options.env ?? process.env;
  const host = options.host?.trim() || env.GITWORTHY_MCP_HOST?.trim() || '127.0.0.1';
  const portRaw = options.port ?? Number(env.GITWORTHY_MCP_PORT ?? 8787);
  const port = Number.isFinite(portRaw) ? Number(portRaw) : 8787;
  const path = normalizePath(options.path?.trim() || env.GITWORTHY_MCP_PATH?.trim() || '/mcp');
  const token = options.token ?? resolveMcpToken(env);
  const configuredHosts = parseAllowedHosts(options.allowedHosts, env);
  const allowedHosts = resolveAllowedHosts({ host, token, allowedHosts: configuredHosts });
  const stateless = options.stateless === true || env.GITWORTHY_MCP_STATELESS === '1';
  const enableJsonResponse = options.enableJsonResponse ?? (stateless || env.GITWORTHY_MCP_JSON_RESPONSE === '1');
  assertHttpBindAllowed({ host, token });
  if (isPublicBindHost(host) && !allowedHosts?.length) {
    console.warn(
      `Warning: MCP HTTP binding ${host} without GITWORTHY_MCP_ALLOWED_HOSTS. ` +
        'Bearer auth is required; consider setting an explicit Host allow-list.'
    );
  }
  return { host, port, path, token, allowedHosts, stateless, enableJsonResponse };
}

/**
 * Start a long-running Streamable HTTP MCP server (Node `http`).
 * Stdio remains the default CLI transport; this is opt-in via `--http`.
 */
export async function startHttpMcpServer(options: StartHttpMcpServerOptions = {}): Promise<StartedHttpMcpServer> {
  const resolved = resolveHttpMcpListenOptions(options);
  const createServerImpl = options.createServerImpl ?? createServer;

  // Stateful session map (ignored in stateless mode).
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: ReturnType<typeof createMcpServer> }>();

  const server = createServerImpl(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${resolved.host}:${resolved.port}`}`);

      if (url.pathname === '/healthz' || url.pathname === '/health') {
        sendJson(res, 200, { ok: true, service: 'gitworthy-mcp' });
        return;
      }

      if (url.pathname !== resolved.path) {
        res.writeHead(404).end('Not Found');
        return;
      }

      if (!hostHeaderAllowed({ hostHeader: req.headers.host, allowedHosts: resolved.allowedHosts })) {
        sendJson(res, 403, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Forbidden: Host header not allowed.' },
          id: null
        });
        return;
      }

      const allowUnauthenticated = !resolved.token && isLoopbackHost(resolved.host);
      const auth = authorizeMcpRequest({
        authorizationHeader: authorizationFromNodeRequest(req),
        expectedToken: resolved.token,
        allowUnauthenticated
      });
      if (!auth.ok) {
        req.resume();
        sendJson(res, auth.status, {
          jsonrpc: '2.0',
          error: { code: -32001, message: auth.message },
          id: null
        });
        return;
      }

      // Stateless path: Web Standard handler (same code as serverless deploy).
      if (resolved.stateless) {
        let body: unknown;
        if ((req.method ?? 'GET').toUpperCase() === 'POST') {
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, {
              jsonrpc: '2.0',
              error: { code: -32700, message: 'Parse error: invalid JSON body.' },
              id: null
            });
            return;
          }
        }
        const webReq = nodeRequestToWeb(req, body, resolved.host, resolved.port);
        const response = await handleMcpHttpRequest(webReq, {
          token: resolved.token,
          allowUnauthenticated,
          allowedHosts: resolved.allowedHosts,
          path: resolved.path,
          enableJsonResponse: resolved.enableJsonResponse
        });
        await writeWebResponse(res, response);
        return;
      }

      // Stateful Streamable HTTP
      const method = (req.method ?? 'GET').toUpperCase();
      let body: unknown;
      if (method === 'POST') {
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error: invalid JSON body.' },
            id: null
          });
          return;
        }
      }

      const sessionHeader = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          sendJson(res, 404, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found.' },
            id: null
          });
          return;
        }
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      if (method === 'POST' && body && isInitializeRequest(body)) {
        const mcpServer = createMcpServer();
        const session: { transport?: StreamableHTTPServerTransport } = {};
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: resolved.enableJsonResponse,
          onsessioninitialized: (id) => {
            if (!session.transport) return;
            sessions.set(id, { transport: session.transport, server: mcpServer });
          },
          onsessionclosed: (id) => {
            const entry = sessions.get(id);
            sessions.delete(id);
            void entry?.transport.close().catch(() => undefined);
            void entry?.server.close().catch(() => undefined);
          }
        });
        session.transport = transport;
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (method === 'GET' || method === 'DELETE') {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided.' },
          id: null
        });
        return;
      }

      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided.' },
        id: null
      });
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(resolved.port, resolved.host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : resolved.port;
  const displayHost = isLoopbackHost(resolved.host) ? '127.0.0.1' : resolved.host;
  const url = `http://${displayHost}:${port}${resolved.path}`;

  return {
    host: resolved.host,
    port,
    path: resolved.path,
    url,
    tokenConfigured: Boolean(resolved.token),
    tokenRequired: Boolean(resolved.token) || !isLoopbackHost(resolved.host),
    server,
    close: async () => {
      for (const [id, entry] of sessions) {
        sessions.delete(id);
        await entry.transport.close().catch(() => undefined);
        await entry.server.close().catch(() => undefined);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

export function httpMcpStartupMessage(started: StartedHttpMcpServer): string {
  const authLine = started.tokenConfigured
    ? `Auth: Authorization Bearer from ${MCP_TOKEN_ENV}`
    : `Auth: disabled (loopback only; Host allow-list enforced). Set ${MCP_TOKEN_ENV} before any public bind.`;
  return [
    `Gitworthy MCP Streamable HTTP listening on ${started.url}`,
    authLine,
    'Health: GET /healthz',
    'Configure Cloud Agents / mobile with url + headers.Authorization.'
  ].join('\n');
}
