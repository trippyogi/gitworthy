import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { PRIMARY_TOOL_NAMES, listToolMetaSnapshot, TOOL_META } from '../src/mcp/tool-meta.js';
import { ErrorResultSchema } from '../src/contracts/index.js';

describe('MCP tool metadata', () => {
  it('exposes a stable metadata snapshot for every registered tool', () => {
    const snap = listToolMetaSnapshot();
    expect(snap.map((item) => item.name)).toEqual(Object.keys(TOOL_META).sort());
    for (const item of snap) {
      expect(item.description.length).toBeGreaterThan(20);
      expect(item.annotations.readOnlyHint === true || item.annotations.readOnlyHint === false).toBe(true);
    }
    expect(PRIMARY_TOOL_NAMES).toEqual(
      expect.arrayContaining(['doctor', 'worth_check', 'hunt', 'brief', 'store_outcome_record', 'store_outcome_reconcile', 'store_outcome_backfill'])
    );
  });

  it('publishes descriptions, annotations, and structuredContent over MCP', async () => {
    const server = createMcpServer();
    const client = new Client({ name: 'gitworthy-test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const doctor = listed.tools.find((tool) => tool.name === 'doctor');
      expect(doctor?.description).toMatch(/capability matrix/i);
      expect(doctor?.annotations?.readOnlyHint).toBe(true);
      expect(doctor?.annotations?.openWorldHint).toBe(true);

      const worth = listed.tools.find((tool) => tool.name === 'worth_check');
      expect(worth?.annotations?.readOnlyHint).toBe(false);

      const migrate = listed.tools.find((tool) => tool.name === 'store_migrate_ledger');
      expect(migrate?.annotations?.destructiveHint).toBe(true);
      expect(migrate?.annotations?.readOnlyHint).toBe(false);

      const ok = await client.callTool({ name: 'list_probe_templates', arguments: {} });
      expect(ok.isError).toBeUndefined();
      expect(ok.structuredContent).toMatchObject({ command: 'probes' });

      const bad = await client.callTool({ name: 'branch_scan', arguments: { repo: 'nope!!', keywords: ['x'] } });
      expect(bad.isError).toBe(true);
      expect(ErrorResultSchema.parse(bad.structuredContent).error.code).toBe('invalid_repo_ref');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
