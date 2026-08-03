/** In-process MCP list/call self-test for release validation (GW-032). */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { PRIMARY_TOOL_NAMES, TOOL_META } from '../src/mcp/tool-meta.js';

async function main(): Promise<void> {
  const server = createMcpServer();
  const client = new Client({ name: 'gitworthy-mcp-self-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const expected = Object.keys(TOOL_META).sort();
    const actual = [...byName.keys()].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`tool list mismatch\nexpected=${expected.join(',')}\nactual=${actual.join(',')}`);
    }

    for (const name of PRIMARY_TOOL_NAMES) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`missing primary tool ${name}`);
      if (!tool.description || tool.description.length < 40) {
        throw new Error(`primary tool ${name} missing useful description`);
      }
      if (!tool.annotations || typeof tool.annotations.readOnlyHint !== 'boolean') {
        throw new Error(`primary tool ${name} missing readOnlyHint annotation`);
      }
    }

    const probes = await client.callTool({ name: 'list_probe_templates', arguments: {} });
    if (probes.isError) throw new Error('list_probe_templates returned isError');
    if (!probes.structuredContent || typeof probes.structuredContent !== 'object') {
      throw new Error('list_probe_templates missing structuredContent');
    }

    const invalid = await client.callTool({ name: 'worth_check', arguments: { repo: 'bad', issue_number: 1 } });
    if (!invalid.isError) throw new Error('worth_check should isError on invalid repo');
    if (!invalid.structuredContent || typeof invalid.structuredContent !== 'object') {
      throw new Error('error result missing structuredContent');
    }

    console.log(`mcp self-test passed (${actual.length} tools, ${PRIMARY_TOOL_NAMES.length} primary)`);
  } finally {
    await client.close();
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
