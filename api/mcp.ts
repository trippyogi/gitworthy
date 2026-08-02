/**
 * Vercel serverless entry for Streamable HTTP MCP.
 * Set GITWORTHY_MCP_TOKEN and GITHUB_TOKEN in the project env.
 *
 * This file is outside `src/` (not part of the npm `tsc` build). Vercel/bundlers
 * resolve the source module directly.
 */
export { default } from '../src/mcp/vercel-handler.ts';
