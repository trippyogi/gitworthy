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
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'brief',
      'brief_show',
      'branch_scan',
      'capture_list',
      'capture_show',
      'case_promote',
      'config_show',
      'config_validate',
      'contention',
      'contrib_policy',
      'doctor',
      'dupe_cluster',
      'hunt',
      'issue_vs_main',
      'ledger_list',
      'ledger_lookup',
      'ledger_record',
      'linked_work',
      'list_probe_templates',
      'org_scan',
      'profile_show',
      'related_cluster',
      'release_gap',
      'scan',
      'scope_check',
      'store_decision_list',
      'store_export',
      'store_migrate_ledger',
      'store_outcome_record',
      'store_recheck',
      'store_rebuild_indexes',
      'store_target_show',
      'worth_check'
    ].sort());
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
