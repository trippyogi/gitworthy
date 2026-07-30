import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  branch_scan,
  contrib_policy,
  doctor,
  dupe_cluster,
  hunt,
  issue_vs_main,
  ledger_list,
  ledger_lookup,
  ledger_record,
  linked_work,
  listProbeTemplates,
  org_scan,
  related_cluster,
  release_gap,
  scan,
  worth_check
} from '../core/index.js';
import { GitworthyError } from '../core/envelope.js';
import { packageVersion } from '../lib/package-meta.js';

function jsonText(value: unknown) {
  const stamped = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...value as Record<string, unknown>, gitworthy_version: packageVersion() }
    : { result: value, gitworthy_version: packageVersion() };
  return { content: [{ type: 'text' as const, text: JSON.stringify(stamped, null, 2) }] };
}

async function withToolErrors<T>(run: () => Promise<T>) {
  try {
    return jsonText(await run());
  } catch (error) {
    if (error instanceof GitworthyError) {
      return jsonText({
        code: error.code,
        message: error.message,
        checked: error.checked,
        not_checked: error.not_checked,
        status: error.status
      });
    }
    throw error;
  }
}

const skillProfileSchema = z.union([
  z.string(),
  z.object({
    languages: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    avoid: z.array(z.string()).optional()
  })
]).optional();

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'gitworthy', version: packageVersion() });
  server.registerTool('doctor', { title: 'Doctor', inputSchema: { probe_repo: z.string().optional(), probe_issue_number: z.number().optional() } }, async (input) => withToolErrors(() => doctor(input)));
  server.registerTool('branch_scan', { title: 'Branch scan', inputSchema: { repo: z.string(), keywords: z.array(z.string()), issue_number: z.number().optional(), max_age_days: z.number().optional(), force_refresh: z.boolean().optional() } }, async (input) => withToolErrors(() => branch_scan(input)));
  server.registerTool('issue_vs_main', { title: 'Issue versus main', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) => withToolErrors(() => issue_vs_main(input)));
  server.registerTool('release_gap', { title: 'Release gap', inputSchema: { repo: z.string(), npm_package: z.string(), probe: z.object({ file_glob: z.string().optional(), contains: z.string().optional() }).optional(), probe_template: z.string().optional(), force_refresh: z.boolean().optional() } }, async (input) => withToolErrors(() => release_gap(input)));
  server.registerTool('dupe_cluster', { title: 'Duplicate cluster', inputSchema: { repo: z.string(), issue_number: z.number(), max_candidates: z.number().optional() } }, async (input) => withToolErrors(() => dupe_cluster(input)));
  server.registerTool('related_cluster', { title: 'Related cluster', inputSchema: { repo: z.string(), issue_number: z.number().optional(), label: z.string().optional(), keywords: z.array(z.string()).optional(), limit: z.number().optional(), min_score: z.number().optional() } }, async (input) => withToolErrors(() => related_cluster(input)));
  server.registerTool('linked_work', { title: 'Linked work', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) => withToolErrors(() => linked_work(input)));
  server.registerTool('contrib_policy', { title: 'Contribution policy', inputSchema: { repo: z.string(), force_refresh: z.boolean().optional() } }, async (input) => withToolErrors(() => contrib_policy(input)));
  server.registerTool('worth_check', { title: 'Worth check', inputSchema: { repo: z.string(), issue_number: z.number(), npm_package: z.string().optional(), probe: z.object({ file_glob: z.string().optional(), contains: z.string().optional() }).optional(), probe_template: z.string().optional() } }, async (input) => withToolErrors(() => worth_check(input)));
  server.registerTool('scan', { title: 'Scan issues', inputSchema: { repo: z.string(), label: z.string().optional(), keywords: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional(), land_hints: z.boolean().optional(), skill_profile: skillProfileSchema } }, async (input) => withToolErrors(() => scan(input)));
  server.registerTool('org_scan', { title: 'Org scan', inputSchema: { org: z.string(), label: z.string().optional(), keywords: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional(), max_repos: z.number().optional(), land_hints: z.boolean().optional(), skill_profile: skillProfileSchema } }, async (input) => withToolErrors(() => org_scan(input)));
  server.registerTool('hunt', {
    title: 'Hunt',
    inputSchema: {
      repo: z.string().optional(),
      org: z.string().optional(),
      label: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      since: z.string().optional(),
      scan_limit: z.number().optional(),
      max_repos: z.number().optional(),
      max_checks: z.number().optional(),
      land_hints: z.boolean().optional(),
      skip_likely_land_only: z.boolean().optional(),
      skip_soft_ask: z.boolean().optional(),
      skip_assigned: z.boolean().optional(),
      skip_ledger_skip: z.boolean().optional(),
      skip_policy_gate: z.boolean().optional(),
      skill_profile: skillProfileSchema,
      npm_package: z.string().optional()
    }
  }, async (input) => withToolErrors(() => hunt(input)));
  server.registerTool('list_probe_templates', { title: 'List probe templates', inputSchema: {} }, async () => withToolErrors(async () => ({
    verdict_summary: `listed ${listProbeTemplates().length} probe templates.`,
    evidence: listProbeTemplates(),
    checked: ['listed built-in probe templates'],
    not_checked: ['probe templates are heuristics; they do not prove an issue-specific fix shipped.'],
    signals: [],
    cached: false,
    fetched_at: new Date().toISOString()
  })));
  server.registerTool('ledger_lookup', { title: 'Ledger lookup', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) => withToolErrors(() => ledger_lookup(input)));
  server.registerTool('ledger_record', { title: 'Ledger record', inputSchema: { repo: z.string(), issue_number: z.number(), verdict: z.string().optional(), disposition: z.string().optional(), quality_score: z.number().optional(), notes: z.string().optional(), source: z.string().optional() } }, async (input) => withToolErrors(() => ledger_record(input)));
  server.registerTool('ledger_list', { title: 'Ledger list', inputSchema: { repo: z.string().optional(), limit: z.number().optional() } }, async (input) => withToolErrors(() => ledger_list(input)));
  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
