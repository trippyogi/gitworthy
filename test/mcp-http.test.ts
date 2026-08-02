import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOPBACK_ALLOWED_HOSTS,
  MCP_TOKEN_ENV,
  assertHttpBindAllowed,
  authorizeMcpRequest,
  hostHeaderAllowed,
  isLoopbackHost,
  requiresMcpTokenForBind,
  resolveAllowedHosts,
  resolveMcpToken
} from '../src/mcp/auth.js';
import { handleMcpHttpRequest } from '../src/mcp/http-handler.js';
import { startHttpMcpServer, type StartedHttpMcpServer } from '../src/mcp/http-server.js';
import { vercelMcpHandler } from '../src/mcp/vercel-handler.js';

const startedServers: StartedHttpMcpServer[] = [];

afterEach(async () => {
  while (startedServers.length) {
    const server = startedServers.pop();
    await server?.close().catch(() => undefined);
  }
});

describe('MCP HTTP auth and bind policy', () => {
  it('classifies loopback vs public binds', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(requiresMcpTokenForBind('127.0.0.1')).toBe(false);
    expect(requiresMcpTokenForBind('0.0.0.0')).toBe(true);
    expect(requiresMcpTokenForBind('mcp.example.com')).toBe(true);
  });

  it('refuses non-loopback bind without token', () => {
    expect(() => assertHttpBindAllowed({ host: '0.0.0.0' })).toThrow(/GITWORTHY_MCP_TOKEN/);
    expect(() => assertHttpBindAllowed({ host: '0.0.0.0', token: 'secret' })).not.toThrow();
  });

  it('fails closed without token unless allowUnauthenticated', () => {
    expect(authorizeMcpRequest({ expectedToken: undefined }).ok).toBe(false);
    expect(authorizeMcpRequest({ expectedToken: undefined, allowUnauthenticated: true }).ok).toBe(true);
    expect(authorizeMcpRequest({ expectedToken: 'secret', authorizationHeader: 'Bearer secret' }).ok).toBe(true);
    expect(authorizeMcpRequest({ expectedToken: 'secret', authorizationHeader: 'Bearer nope' }).ok).toBe(false);
  });

  it('defaults Host allow-list for tokenless loopback', () => {
    expect(resolveAllowedHosts({ host: '127.0.0.1' })).toEqual(DEFAULT_LOOPBACK_ALLOWED_HOSTS);
    expect(hostHeaderAllowed({ hostHeader: '127.0.0.1:8787', allowedHosts: DEFAULT_LOOPBACK_ALLOWED_HOSTS })).toBe(true);
    expect(hostHeaderAllowed({ hostHeader: 'evil.com', allowedHosts: DEFAULT_LOOPBACK_ALLOWED_HOSTS })).toBe(false);
  });

  it('resolves token from env', () => {
    expect(resolveMcpToken({ [MCP_TOKEN_ENV]: ' abc ' })).toBe('abc');
    expect(resolveMcpToken({})).toBeUndefined();
  });
});

describe('MCP HTTP handler', () => {
  it('rejects unauthenticated handler calls by default', async () => {
    const response = await handleMcpHttpRequest(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }), { path: '/mcp' });
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toMatch(/GITWORTHY_MCP_TOKEN/);
    expect(text).not.toMatch(/Authorization:\s*Bearer\s+\S+/i);
  });

  it('rejects missing bearer when token configured', async () => {
    const response = await handleMcpHttpRequest(new Request('http://127.0.0.1/mcp', { method: 'POST' }), {
      token: 'secret',
      path: '/mcp'
    });
    expect(response.status).toBe(401);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/Bearer/i);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('serves healthz without auth', async () => {
    const response = await handleMcpHttpRequest(new Request('http://127.0.0.1/healthz'), {
      token: 'secret'
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: 'gitworthy-mcp' });
  });

  it('rejects DNS-rebinding Host on tokenless loopback allow-list', async () => {
    expect(hostHeaderAllowed({
      hostHeader: 'evil.com',
      allowedHosts: resolveAllowedHosts({ host: '127.0.0.1' })
    })).toBe(false);

    const handlerResponse = await handleMcpHttpRequest(
      new Request('http://evil.com/mcp', {
        method: 'POST',
        headers: { host: 'evil.com', 'content-type': 'application/json' },
        body: '{}'
      }),
      {
        allowUnauthenticated: true,
        allowedHosts: resolveAllowedHosts({ host: '127.0.0.1' }),
        path: '/mcp'
      }
    );
    expect(handlerResponse.status).toBe(403);
  });

  it('completes a stateless tool round-trip with bearer auth', async () => {
    const token = 'test-mcp-token-roundtrip';
    const started = await startHttpMcpServer({
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      token,
      stateless: true,
      enableJsonResponse: true
    });
    startedServers.push(started);

    const client = new Client({ name: 'gitworthy-http-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(started.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.some((tool) => tool.name === 'doctor')).toBe(true);
    const result = await client.callTool({ name: 'list_probe_templates', arguments: {} });
    expect(result.isError).not.toBe(true);
    // Second call without session header still works in stateless mode.
    const again = await client.callTool({ name: 'list_probe_templates', arguments: {} });
    expect(again.isError).not.toBe(true);
    await client.close();
    await transport.close();
  });

  it('completes a stateful session round-trip on loopback without token', async () => {
    const started = await startHttpMcpServer({
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      stateless: false,
      enableJsonResponse: true
    });
    startedServers.push(started);

    const client = new Client({ name: 'gitworthy-http-stateful-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(started.url));
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain('worth_check');
    await client.close();
    await transport.close();
  });

  it('returns 404 for unknown stateful session ids', async () => {
    const started = await startHttpMcpServer({
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      stateless: false,
      enableJsonResponse: true
    });
    startedServers.push(started);

    const response = await fetch(started.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'missing-session'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/session not found/i);
  });

  it('vercel handler refuses missing token', async () => {
    const previous = process.env.GITWORTHY_MCP_TOKEN;
    delete process.env.GITWORTHY_MCP_TOKEN;
    try {
      const response = await vercelMcpHandler(new Request('https://example.com/api/mcp', { method: 'POST' }));
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).toMatch(/GITWORTHY_MCP_TOKEN/);
    } finally {
      if (previous === undefined) delete process.env.GITWORTHY_MCP_TOKEN;
      else process.env.GITWORTHY_MCP_TOKEN = previous;
    }
  });
});
