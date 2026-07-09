import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { branch_scan, contrib_policy, dupe_cluster, issue_vs_main, linked_work, release_gap, scan, worth_check } from '../core/index.js';

function jsonText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'gitworthy', version: '0.2.0' });
  server.registerTool('branch_scan', { title: 'Branch scan', inputSchema: { repo: z.string(), keywords: z.array(z.string()), max_age_days: z.number().optional(), force_refresh: z.boolean().optional() } }, async (input) => jsonText(await branch_scan(input)));
  server.registerTool('issue_vs_main', { title: 'Issue versus main', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) => jsonText(await issue_vs_main(input)));
  server.registerTool('release_gap', { title: 'Release gap', inputSchema: { repo: z.string(), npm_package: z.string(), probe: z.object({ file_glob: z.string().optional(), contains: z.string().optional() }).optional(), force_refresh: z.boolean().optional() } }, async (input) => jsonText(await release_gap(input)));
  server.registerTool('dupe_cluster', { title: 'Duplicate cluster', inputSchema: { repo: z.string(), issue_number: z.number(), max_candidates: z.number().optional() } }, async (input) => jsonText(await dupe_cluster(input)));
  server.registerTool('linked_work', { title: 'Linked work', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) => jsonText(await linked_work(input)));
  server.registerTool('contrib_policy', { title: 'Contribution policy', inputSchema: { repo: z.string(), force_refresh: z.boolean().optional() } }, async (input) => jsonText(await contrib_policy(input)));
  server.registerTool('worth_check', { title: 'Worth check', inputSchema: { repo: z.string(), issue_number: z.number(), npm_package: z.string().optional(), probe: z.object({ file_glob: z.string().optional(), contains: z.string().optional() }).optional() } }, async (input) => jsonText(await worth_check(input)));
  server.registerTool('scan', { title: 'Scan issues', inputSchema: { repo: z.string(), label: z.string().optional(), keywords: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional() } }, async (input) => jsonText(await scan(input)));
  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
