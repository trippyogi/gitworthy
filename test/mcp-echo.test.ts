import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { packageVersion } from '../src/lib/package-meta.js';
import { createMcpServer } from '../src/mcp/server.js';

describe('MCP tools', () => {
  it('registers all core tools', async () => {
    const server = createMcpServer();
    const client = new Client({ name: 'gitworthy-test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(['branch_scan', 'contrib_policy', 'dupe_cluster', 'issue_vs_main', 'ledger_add', 'ledger_claim', 'ledger_list', 'ledger_update', 'linked_work', 'release_gap', 'scan', 'worth_check'].sort());
    await client.close();
    await server.close();
  });

  it('reports the same version as package.json', async () => {
    const packageJsonVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    expect(packageVersion()).toBe(packageJsonVersion);

    const server = createMcpServer();
    const client = new Client({ name: 'gitworthy-test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerVersion()?.version).toBe(packageJsonVersion);
    await client.close();
    await server.close();
  });
});
