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
import { packageVersion } from '../lib/package-meta.js';
import { toCheckResult, toErrorResult, toStampedLegacyResult } from '../contracts/index.js';

function jsonText(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true as const } : {})
  };
}

async function withToolErrors<T>(command: string, run: () => Promise<T>, map?: (value: T) => unknown) {
  try {
    const value = await run();
    return jsonText(map ? map(value) : value);
  } catch (error) {
    return jsonText(toErrorResult({ command, error }), true);
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
  const stamp = (command: string) => (value: unknown) => toStampedLegacyResult(command, value as Record<string, unknown>);
  server.registerTool('doctor', { title: 'Doctor', inputSchema: { probe_repo: z.string().optional(), probe_issue_number: z.number().optional() } }, async (input) => withToolErrors('doctor', () => doctor(input), stamp('doctor')));
  server.registerTool('branch_scan', { title: 'Branch scan', inputSchema: { repo: z.string(), keywords: z.array(z.string()), issue_number: z.number().optional(), max_age_days: z.number().optional(), force_refresh: z.boolean().optional() } }, async (input) => withToolErrors('branch_scan', () => branch_scan(input), stamp('branch_scan')));
  server.registerTool('issue_vs_main', { title: 'Issue versus main', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) => withToolErrors('issue_vs_main', () => issue_vs_main(input), stamp('issue_vs_main')));
  server.registerTool('release_gap', { title: 'Release gap', inputSchema: { repo: z.string(), npm_package: z.string(), probe: z.object({ file_glob: z.string().optional(), contains: z.string().optional() }).optional(), probe_template: z.string().optional(), force_refresh: z.boolean().optional() } }, async (input) => withToolErrors('release_gap', () => release_gap(input), stamp('release_gap')));
  server.registerTool('dupe_cluster', { title: 'Duplicate cluster', inputSchema: { repo: z.string(), issue_number: z.number(), max_candidates: z.number().optional() } }, async (input) => withToolErrors('dupe_cluster', () => dupe_cluster(input), stamp('dupe_cluster')));
  server.registerTool('related_cluster', { title: 'Related cluster', inputSchema: { repo: z.string(), issue_number: z.number().optional(), label: z.string().optional(), keywords: z.array(z.string()).optional(), limit: z.number().optional(), min_score: z.number().optional() } }, async (input) => withToolErrors('related_cluster', () => related_cluster(input), stamp('related_cluster')));
  server.registerTool('linked_work', { title: 'Linked work', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) => withToolErrors('linked_work', () => linked_work(input), stamp('linked_work')));
  server.registerTool('contrib_policy', { title: 'Contribution policy', inputSchema: { repo: z.string(), force_refresh: z.boolean().optional() } }, async (input) => withToolErrors('contrib_policy', () => contrib_policy(input), stamp('contrib_policy')));
  server.registerTool('worth_check', { title: 'Worth check', inputSchema: { repo: z.string(), issue_number: z.number(), npm_package: z.string().optional(), probe: z.object({ file_glob: z.string().optional(), contains: z.string().optional() }).optional(), probe_template: z.string().optional() } }, async (input) => withToolErrors('check', () => worth_check(input), (value) => toCheckResult(value as Record<string, unknown>, { repo: input.repo, issue_number: input.issue_number })));
  server.registerTool('scan', { title: 'Scan issues', inputSchema: { repo: z.string(), label: z.string().optional(), keywords: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional(), land_hints: z.boolean().optional(), skill_profile: skillProfileSchema } }, async (input) => withToolErrors('scan', () => scan(input), stamp('scan')));
  server.registerTool('org_scan', { title: 'Org scan', inputSchema: { org: z.string(), label: z.string().optional(), keywords: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional(), max_repos: z.number().optional(), land_hints: z.boolean().optional(), skill_profile: skillProfileSchema } }, async (input) => withToolErrors('org_scan', () => org_scan(input), stamp('org_scan')));
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
  }, async (input) => withToolErrors('hunt', () => hunt(input), stamp('hunt')));
  server.registerTool('list_probe_templates', { title: 'List probe templates', inputSchema: {} }, async () => withToolErrors('probes', async () => ({
    verdict_summary: `listed ${listProbeTemplates().length} probe templates.`,
    evidence: listProbeTemplates(),
    checked: ['listed built-in probe templates'],
    not_checked: ['probe templates are heuristics; they do not prove an issue-specific fix shipped.'],
    signals: [],
    cached: false,
    fetched_at: new Date().toISOString()
  }), stamp('probes')));
  server.registerTool('ledger_lookup', { title: 'Ledger lookup', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) => withToolErrors('ledger_lookup', () => ledger_lookup(input), stamp('ledger_lookup')));
  server.registerTool('ledger_record', { title: 'Ledger record', inputSchema: { repo: z.string(), issue_number: z.number(), verdict: z.string().optional(), disposition: z.string().optional(), quality_score: z.number().optional(), notes: z.string().optional(), source: z.string().optional() } }, async (input) => withToolErrors('ledger_record', () => ledger_record(input), stamp('ledger_record')));
  server.registerTool('ledger_list', { title: 'Ledger list', inputSchema: { repo: z.string().optional(), limit: z.number().optional() } }, async (input) => withToolErrors('ledger_list', () => ledger_list(input), stamp('ledger_list')));
  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
