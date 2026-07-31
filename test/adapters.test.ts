import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { createMcpServer } from '../src/mcp/server.js';
import { SCHEMA_VERSION } from '../src/contracts/index.js';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;

vi.mock('../src/lib/git.js', () => ({
  lsRemoteHeads: vi.fn(async () => []),
  shallowClone: vi.fn(async () => ({ dir: process.cwd(), cleanup: async () => undefined }))
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: vi.fn(async () => ({ number: 1, title: 'Add fastapi example', body: 'example-apps/fastapi', state: 'open', labels: [], comments: 0, html_url: 'https://github.com/o/r/issues/1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null })),
  fetchRaw: vi.fn(async () => null)
}));

function stableContract(value: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...value };
  delete clone.run_id;
  delete clone.decision_id;
  return clone;
}

describe('adapters', () => {
  it('returns equivalent branch_scan payload through CLI and MCP', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    let cli = '';
    const code = await runCli(['branches', 'o/r', 'abc', '--json', '--force-refresh'], (text) => { cli += text; });
    expect(code).toBe(0);
    const server = createMcpServer();
    const client = new Client({ name: 'gitworthy-test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'branch_scan', arguments: { repo: 'o/r', keywords: ['abc'], force_refresh: true } });
    const mcpText = (result.content as Array<{ type: string; text: string }>)[0].text;
    const mcpPayload = JSON.parse(mcpText) as Record<string, unknown>;
    const cliPayload = JSON.parse(cli) as Record<string, unknown>;
    expect(mcpPayload.gitworthy_version).toBe(packageVersion);
    expect(cliPayload.gitworthy_version).toBe(packageVersion);
    expect(mcpPayload.schema_version).toBe(SCHEMA_VERSION);
    expect(cliPayload.schema_version).toBe(SCHEMA_VERSION);
    expect(stableContract(cliPayload)).toEqual(stableContract(mcpPayload));
    await client.close();
    await server.close();
    vi.useRealTimers();
  });
});
