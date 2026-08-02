import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCP_TOKEN_ENV,
  assertHttpBindAllowed,
  authorizeMcpRequest,
  isLoopbackHost,
  requiresMcpTokenForBind,
  resolveMcpToken
} from '../src/mcp/auth.js';
import { handleMcpHttpRequest } from '../src/mcp/http-handler.js';
import { startHttpMcpServer, type StartedHttpMcpServer } from '../src/mcp/http-server.js';

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

  it('authorizes bearer tokens with timing-safe compare', () => {
    expect(authorizeMcpRequest({ expectedToken: undefined }).ok).toBe(true);
    expect(authorizeMcpRequest({ expectedToken: 'secret', authorizationHeader: 'Bearer secret' }).ok).toBe(true);
    expect(authorizeMcpRequest({ expectedToken: 'secret', authorizationHeader: 'Bearer nope' }).ok).toBe(false);
    expect(authorizeMcpRequest({ expectedToken: 'secret', authorizationHeader: undefined }).ok).toBe(false);
  });

  it('resolves token from env', () => {
    expect(resolveMcpToken({ [MCP_TOKEN_ENV]: ' abc ' })).toBe('abc');
    expect(resolveMcpToken({})).toBeUndefined();
  });
});

describe('MCP HTTP handler', () => {
  it('rejects missing bearer when token configured', async () => {
    const response = await handleMcpHttpRequest(new Request('http://127.0.0.1/mcp', { method: 'POST' }), {
      token: 'secret',
      path: '/mcp',
      stateless: true
    });
    expect(response.status).toBe(401);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/Bearer/i);
  });

  it('serves healthz without auth', async () => {
    const response = await handleMcpHttpRequest(new Request('http://127.0.0.1/healthz'), {
      token: 'secret'
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: 'gitworthy-mcp' });
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
});
