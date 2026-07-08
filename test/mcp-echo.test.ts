import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';

describe('phase one MCP echo tool', () => {
  it('is listable and callable', async () => {
    const server = createMcpServer();
    const client = new Client({ name: 'gitworthy-test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain('echo');
    const result = await client.callTool({ name: 'echo', arguments: { text: 'ready' } });
    expect(result.content).toEqual([{ type: 'text', text: 'ready' }]);
    await client.close();
    await server.close();
  });
});
