import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { createMcpServer } from '../src/mcp/server.js';

vi.mock('../src/lib/git.js', () => ({
  lsRemoteHeads: vi.fn(async () => []),
  shallowClone: vi.fn(async () => ({ dir: process.cwd(), cleanup: async () => undefined }))
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: vi.fn(async () => ({ number: 1, title: 'Add fastapi example', body: 'example-apps/fastapi', state: 'open', labels: [], comments: 0, html_url: 'https://github.com/o/r/issues/1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null })),
  fetchRaw: vi.fn(async () => null)
}));

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
    expect(JSON.parse(cli)).toEqual(JSON.parse(mcpText));
    await client.close();
    await server.close();
    vi.useRealTimers();
  });
});
