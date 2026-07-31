import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { ErrorResultSchema, RepoRefSchema } from '../../src/contracts/index.js';

/**
 * GW-014: hostile-shaped CLI/MCP inputs must fail validation before any
 * network or git call is attempted. test/cli-input-validation.test.ts and
 * test/mcp-input-validation.test.ts (GW-007) already cover the baseline
 * malformed-input matrix; this file adds injection/traversal/unbounded-length
 * shaped values that a fuzzer or malicious MCP client could plausibly send,
 * and it deliberately carries no lib/git or lib/github mocks — a stray
 * network/subprocess call from these cases would hang or throw a mock-less
 * runtime error rather than the expected typed input error.
 */

const HOSTILE_REPO_VALUES = [
  { label: 'shell metacharacters (semicolon)', value: 'owner/repo; rm -rf /' },
  { label: 'shell metacharacters (backticks)', value: 'owner/repo`whoami`' },
  { label: 'shell metacharacters (command substitution)', value: 'owner/repo$(whoami)' },
  { label: 'path traversal shape', value: '../../etc/passwd' },
  { label: 'embedded null byte', value: 'owner/rep\u0000o' },
  { label: 'URL-injection shape (userinfo separator)', value: 'owner/repo@evil.example.com' },
  { label: 'URL-injection shape (scheme-like)', value: 'https://evil.example.com/owner/repo' },
  { label: 'unbounded length', value: `${'a'.repeat(200)}/${'b'.repeat(200)}` }
];

async function runCliCommand(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, (text) => { stdout += text; }, (text) => { stderr += text; });
  return { code, stdout, stderr };
}

async function callMcpTool(name: string, args: Record<string, unknown>) {
  const server = createMcpServer();
  const client = new Client({ name: 'gitworthy-security-test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

function textOf(result: Awaited<ReturnType<typeof callMcpTool>>): unknown {
  return JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
}

describe('RepoRefSchema rejects hostile-shaped values directly', () => {
  for (const { label, value } of HOSTILE_REPO_VALUES) {
    it(`rejects: ${label}`, () => {
      expect(RepoRefSchema.safeParse(value).success).toBe(false);
    });
  }

  it('still accepts a maximum-realistic-length legitimate repo ref', () => {
    // 39-char owner (GitHub's login cap) + 100-char repo name (GitHub's repo name cap).
    const owner = 'a'.repeat(39);
    const repoName = 'b'.repeat(100);
    expect(RepoRefSchema.safeParse(`${owner}/${repoName}`).success).toBe(true);
  });
});

describe('CLI: hostile repo values fail before any network/git call', () => {
  for (const { label, value } of HOSTILE_REPO_VALUES) {
    it(`rejects for \`scan\` (${label})`, async () => {
      const { code, stdout } = await runCliCommand(['scan', value, '--json']);
      expect(code).toBe(2);
      const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
      expect(parsed.ok).toBe(false);
      expect(parsed.error.category).toBe('input');
    });

    it(`rejects for \`check\` (${label})`, async () => {
      const { code, stdout } = await runCliCommand(['check', `${value}#1`, '--json']);
      expect(code).toBe(2);
      const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
      expect(parsed.ok).toBe(false);
      expect(parsed.error.category).toBe('input');
    });
  }
});

describe('MCP: hostile repo values fail before any network/git call', () => {
  for (const { label, value } of HOSTILE_REPO_VALUES) {
    it(`rejects for branch_scan (${label})`, async () => {
      const result = await callMcpTool('branch_scan', { repo: value, keywords: ['abc'] });
      expect(result.isError).toBe(true);
      const parsed = ErrorResultSchema.parse(textOf(result));
      expect(parsed.error.category).toBe('input');
    });

    it(`rejects for worth_check (${label})`, async () => {
      const result = await callMcpTool('worth_check', { repo: value, issue_number: 1 });
      expect(result.isError).toBe(true);
      const parsed = ErrorResultSchema.parse(textOf(result));
      expect(parsed.error.category).toBe('input');
    });
  }
});
