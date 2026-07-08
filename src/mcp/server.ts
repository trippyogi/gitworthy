import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'gitworthy', version: '0.1.0' });
  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Return the input text. This temporary phase one tool verifies MCP transport.',
      inputSchema: { text: z.string() }
    },
    async ({ text }) => ({ content: [{ type: 'text', text }] })
  );
  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
