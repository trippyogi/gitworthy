import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';
import { ErrorResultSchema } from '../src/contracts/index.js';

// All of these tool calls carry invalid input, so none should ever reach a GitHub/git network
// call; there are deliberately no lib/git or lib/github mocks in this file.
async function callTool(name: string, args: Record<string, unknown>) {
  const server = createMcpServer();
  const client = new Client({ name: 'gitworthy-test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

function textOf(result: Awaited<ReturnType<typeof callTool>>): unknown {
  return JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
}

describe('MCP input validation', () => {
  it('returns isError + ErrorResult for a malformed repo', async () => {
    const result = await callTool('branch_scan', { repo: 'not_a_valid_repo!!', keywords: ['abc'] });
    expect(result.isError).toBe(true);
    const parsed = ErrorResultSchema.parse(textOf(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.category).toBe('input');
    expect(parsed.error.code).toBe('invalid_repo_ref');
  });

  it('returns isError + ErrorResult for a non-positive issue number', async () => {
    const result = await callTool('issue_vs_main', { repo: 'o/r', issue_number: 0 });
    expect(result.isError).toBe(true);
    const parsed = ErrorResultSchema.parse(textOf(result));
    expect(parsed.error.code).toBe('invalid_issue_number');
  });

  it('returns isError + ErrorResult when hunt gets neither repo nor org', async () => {
    const result = await callTool('hunt', {});
    expect(result.isError).toBe(true);
    const parsed = ErrorResultSchema.parse(textOf(result));
    expect(parsed.error.category).toBe('input');
  });

  it('returns isError + ErrorResult for an invalid org login', async () => {
    const result = await callTool('org_scan', { org: 'not a login' });
    expect(result.isError).toBe(true);
    const parsed = ErrorResultSchema.parse(textOf(result));
    expect(parsed.error.code).toBe('invalid_org_ref');
  });

  it('returns isError + ErrorResult for an out-of-enum ledger verdict', async () => {
    const result = await callTool('ledger_record', { repo: 'o/r', issue_number: 1, verdict: 'MAYBE' });
    expect(result.isError).toBe(true);
    const parsed = ErrorResultSchema.parse(textOf(result));
    expect(parsed.error.category).toBe('input');
  });

  it('succeeds normally for a well-formed doctor call with no probe args', async () => {
    const result = await callTool('list_probe_templates', {});
    expect(result.isError).toBeUndefined();
  });
});
