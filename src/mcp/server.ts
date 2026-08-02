import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  branch_scan,
  capture_list,
  capture_show,
  case_promote,
  contrib_policy,
  doctor,
  dupe_cluster,
  generateBrief,
  hunt,
  issue_vs_main,
  ledger_list,
  ledger_lookup,
  ledger_record,
  linked_work,
  contention,
  check_scope,
  listProbeTemplates,
  org_scan,
  related_cluster,
  release_gap,
  scan,
  store_decision_list,
  store_export,
  store_migrate_ledger,
  store_outcome_record,
  store_recheck,
  store_rebuild_indexes,
  store_target_show,
  worth_check
} from '../core/index.js';
import {
  assertEffectiveConfigSafeToShow,
  loadEffectiveConfig,
  profileForShow,
  resolveHuntFromConfig,
  resolveOrgFromConfig,
  resolveScanFromConfig,
  validateConfigSelection
} from '../lib/config.js';
import { packageVersion } from '../lib/package-meta.js';
import {
  BranchScanInputSchema,
  BriefShowInputSchema,
  CaptureListInputSchema,
  CaptureShowInputSchema,
  CasePromoteInputSchema,
  ContribPolicyInputSchema,
  ConfigShowInputSchema,
  ConfigValidateInputSchema,
  DoctorInputSchema,
  DupeClusterInputSchema,
  HuntInputSchema,
  IssueVsMainInputSchema,
  LedgerListInputSchema,
  LedgerLookupInputSchema,
  LedgerRecordInputSchema,
  LinkedWorkInputSchema,
  ContentionInputSchema,
  ScopeCheckInputSchema,
  OrgScanInputSchema,
  parseToolInput,
  ProfileShowInputSchema,
  RelatedClusterInputSchema,
  ReleaseGapInputSchema,
  ScanInputSchema,
  toCheckResult,
  toErrorResult,
  toStampedLegacyResult,
  WorthCheckInputSchema
} from '../contracts/index.js';
import { persistCheckResultBestEffort } from '../lib/store.js';
import { captureTargetForOrg, captureTargetForRepo, captureTargetForRepoIssue } from '../lib/capture-policy.js';
import { putCaptureManifest } from '../lib/capture-store.js';
import { withCaptureSession } from '../lib/capture-session.js';

function jsonText(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true as const } : {})
  };
}

function captureRequested(input: { capture?: boolean; capture_local_private?: boolean }): boolean {
  return input.capture === true || input.capture_local_private === true;
}

function captureMode(input: { capture_local_private?: boolean }): 'public' | 'local_only' {
  return input.capture_local_private === true ? 'local_only' : 'public';
}

function withCaptureOutput<T extends Record<string, unknown>>(output: T, manifest: { capture_id: string; capture_mode: string; promotable: boolean }): T & { capture: { capture_id: string; capture_mode: string; promotable: boolean } } {
  return {
    ...output,
    capture: {
      capture_id: manifest.capture_id,
      capture_mode: manifest.capture_mode,
      promotable: manifest.promotable
    }
  };
}

function extractHuntDecisionIds(output: Record<string, unknown>): string[] {
  const evidence = Array.isArray(output.evidence) ? output.evidence : [];
  const ids: string[] = [];
  for (const item of evidence) {
    if (!item || typeof item !== 'object') continue;
    const worth = (item as { worth_check?: unknown }).worth_check;
    if (!worth || typeof worth !== 'object') continue;
    const id = (worth as { decision_id?: unknown }).decision_id;
    if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function withToolErrors<T>(command: string, run: () => Promise<T> | T, map?: (value: T) => unknown) {
  try {
    const value = await run();
    return jsonText(map ? map(value) : value);
  } catch (error) {
    return jsonText(toErrorResult({ command, error }), true);
  }
}

/**
 * Tool registration shapes are intentionally loose (primitive zod types only). The MCP SDK
 * validates `arguments` against this shape itself and throws a protocol-level McpError before our
 * handler ever runs, so anything stricter here (regex/enum/positivity) would bypass our
 * `withToolErrors` -> `toErrorResult` + `isError: true` contract. Real strictness is applied inside
 * each handler via the shared contracts/inputs.ts schemas and `parseToolInput`.
 */
const skillProfileSchema = z.union([
  z.string(),
  z.object({
    languages: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    preferred_ecosystems: z.array(z.string()).optional(),
    avoid: z.array(z.string()).optional(),
    avoid_languages: z.array(z.string()).optional(),
    avoid_topics: z.array(z.string()).optional(),
    avoid_ecosystems: z.array(z.string()).optional()
  })
]).optional();

const probeShape = { file_glob: z.string().optional(), contains: z.string().optional() };

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'gitworthy', version: packageVersion() });
  const stamp = (command: string) => (value: unknown) => toStampedLegacyResult(command, value as Record<string, unknown>);
  server.registerTool('doctor', { title: 'Doctor', inputSchema: { probe_repo: z.string().optional(), probe_issue_number: z.number().optional() } }, async (input) =>
    withToolErrors('doctor', () => doctor(parseToolInput(DoctorInputSchema, input)), stamp('doctor')));
  server.registerTool('branch_scan', { title: 'Branch scan', inputSchema: { repo: z.string(), keywords: z.array(z.string()), issue_number: z.number().optional(), max_age_days: z.number().optional(), force_refresh: z.boolean().optional() } }, async (input) =>
    withToolErrors('branch_scan', () => branch_scan(parseToolInput(BranchScanInputSchema, input)), stamp('branch_scan')));
  server.registerTool('issue_vs_main', { title: 'Issue versus main', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) =>
    withToolErrors('issue_vs_main', () => issue_vs_main(parseToolInput(IssueVsMainInputSchema, input)), stamp('issue_vs_main')));
  server.registerTool('release_gap', { title: 'Release gap', inputSchema: { repo: z.string(), npm_package: z.string(), probe: z.object(probeShape).optional(), probe_template: z.string().optional(), force_refresh: z.boolean().optional() } }, async (input) =>
    withToolErrors('release_gap', () => release_gap(parseToolInput(ReleaseGapInputSchema, input)), stamp('release_gap')));
  server.registerTool('dupe_cluster', { title: 'Duplicate cluster', inputSchema: { repo: z.string(), issue_number: z.number(), max_candidates: z.number().optional() } }, async (input) =>
    withToolErrors('dupe_cluster', () => dupe_cluster(parseToolInput(DupeClusterInputSchema, input)), stamp('dupe_cluster')));
  server.registerTool('related_cluster', { title: 'Related cluster', inputSchema: { repo: z.string(), issue_number: z.number().optional(), label: z.string().optional(), keywords: z.array(z.string()).optional(), limit: z.number().optional(), min_score: z.number().optional() } }, async (input) =>
    withToolErrors('related_cluster', () => related_cluster(parseToolInput(RelatedClusterInputSchema, input)), stamp('related_cluster')));
  server.registerTool('linked_work', { title: 'Linked work', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) =>
    withToolErrors('linked_work', () => linked_work(parseToolInput(LinkedWorkInputSchema, input)), stamp('linked_work')));
  server.registerTool('contention', { title: 'Contention analysis', inputSchema: { repo: z.string(), issue_number: z.number(), include_diffs: z.boolean().optional(), include_gaps: z.boolean().optional(), budget_bytes: z.number().optional() } }, async (input) =>
    withToolErrors('contention', () => contention(parseToolInput(ContentionInputSchema, input)), stamp('contention')));
  server.registerTool('scope_check', { title: 'Scope check', inputSchema: { repo: z.string(), issue_number: z.number(), diff_path: z.string().optional(), diff_cwd: z.string().optional(), base_ref: z.string().optional() } }, async (input) =>
    withToolErrors('scope_check', () => check_scope(parseToolInput(ScopeCheckInputSchema, input)), stamp('scope_check')));
  server.registerTool('contrib_policy', { title: 'Contribution policy', inputSchema: { repo: z.string(), force_refresh: z.boolean().optional() } }, async (input) =>
    withToolErrors('contrib_policy', () => contrib_policy(parseToolInput(ContribPolicyInputSchema, input)), stamp('contrib_policy')));
  server.registerTool('config_validate', { title: 'Validate config', inputSchema: { path: z.string().optional(), user: z.boolean().optional(), repo: z.boolean().optional(), manifest_path: z.string().optional() } }, async (input) =>
    withToolErrors('config_validate', () => validateConfigSelection(parseToolInput(ConfigValidateInputSchema, input)), (value) => ({
      command: 'config_validate',
      verdict_summary: 'config validation complete',
      ...value,
      checked: ['validated selected config file(s) and target manifest(s)'],
      not_checked: ['tokens are not read from config; use GITHUB_TOKEN or GH_TOKEN environment variables.']
    })));
  server.registerTool('config_show', { title: 'Show effective config', inputSchema: { effective: z.boolean().optional(), path: z.string().optional(), cwd: z.string().optional() } }, async (input) =>
    withToolErrors('config_show', async () => {
      const parsed = parseToolInput(ConfigShowInputSchema, input);
      const effective = await loadEffectiveConfig({ cwd: parsed.cwd, userPath: parsed.path });
      assertEffectiveConfigSafeToShow(effective);
      return {
        command: 'config_show',
        verdict_summary: 'resolved effective config',
        effective: parsed.effective !== false,
        values: effective.values,
        provenance: effective.provenance,
        paths: effective.paths,
        loaded: effective.loaded,
        checked: ['resolved config precedence: input > env > repo > user > defaults'],
        not_checked: ['secret values are not shown; GitHub tokens remain env-only via GITHUB_TOKEN or GH_TOKEN.']
      };
    }));
  server.registerTool('profile_show', { title: 'Show skill profile', inputSchema: { path: z.string().optional(), cwd: z.string().optional() } }, async (input) =>
    withToolErrors('profile_show', async () => {
      const parsed = parseToolInput(ProfileShowInputSchema, input);
      const effective = await loadEffectiveConfig({ cwd: parsed.cwd, userPath: parsed.path });
      assertEffectiveConfigSafeToShow(effective);
      const profile = profileForShow(effective);
      return {
        command: 'profile_show',
        verdict_summary: profile ? 'resolved skill profile' : 'no skill profile configured',
        profile,
        provenance: profile ? effective.provenance.skill_profile ?? null : null,
        checked: ['resolved skill profile from config precedence'],
        not_checked: ['skill profile affects scan/hunt ranking inputs only; it never changes hard verdict policy.']
      };
    }));
  server.registerTool('worth_check', { title: 'Worth check', inputSchema: { repo: z.string(), issue_number: z.number(), npm_package: z.string().optional(), probe: z.object(probeShape).optional(), probe_template: z.string().optional(), capture: z.boolean().optional(), capture_local_private: z.boolean().optional() } }, async (input) =>
    withToolErrors('check', async () => {
      const parsed = parseToolInput(WorthCheckInputSchema, input);
      const runCheck = async () => {
        const legacy = await worth_check(parsed);
        const check = toCheckResult(legacy as Record<string, unknown>, { repo: parsed.repo, issue_number: parsed.issue_number });
        await persistCheckResultBestEffort(check);
        return check;
      };
      if (!captureRequested(parsed)) return runCheck();
      const mode = captureMode(parsed);
      const target = await captureTargetForRepoIssue({ repo: parsed.repo, issue_number: parsed.issue_number, capture_mode: mode });
      const captured = await withCaptureSession({
        command: 'check',
        capture_mode: mode,
        target,
        source: { surface: 'mcp', attribution: 'worth_check capture' }
      }, async (session) => {
        const check = await runCheck();
        session.linkRun({ run_id: check.run_id, decision_id: check.decision_id });
        return check;
      });
      const manifest = await putCaptureManifest(captured.manifest);
      return withCaptureOutput(captured.value, manifest);
    }));
  server.registerTool('scan', { title: 'Scan issues', inputSchema: { repo: z.string(), label: z.string().optional(), keywords: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional(), land_hints: z.boolean().optional(), skill_profile: skillProfileSchema, manifest_path: z.string().optional(), max_pages: z.number().optional(), explain_ranking: z.boolean().optional() } }, async (input) =>
    withToolErrors('scan', async () => {
      const parsed = parseToolInput(ScanInputSchema, input);
      return scan(resolveScanFromConfig(parsed, await loadEffectiveConfig({ input: parsed })));
    }, stamp('scan')));
  server.registerTool('org_scan', { title: 'Org scan', inputSchema: { org: z.string().optional(), label: z.string().optional(), keywords: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional(), max_repos: z.number().optional(), land_hints: z.boolean().optional(), skill_profile: skillProfileSchema, manifest_path: z.string().optional(), max_pages: z.number().optional(), explain_ranking: z.boolean().optional() } }, async (input) =>
    withToolErrors('org_scan', async () => {
      const parsed = parseToolInput(OrgScanInputSchema, input);
      return org_scan(resolveOrgFromConfig(parsed, await loadEffectiveConfig({ input: parsed })));
    }, stamp('org_scan')));
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
      max_pages: z.number().optional(),
      land_hints: z.boolean().optional(),
      skip_likely_land_only: z.boolean().optional(),
      skip_soft_ask: z.boolean().optional(),
      skip_assigned: z.boolean().optional(),
      skip_ledger_skip: z.boolean().optional(),
      skip_policy_gate: z.boolean().optional(),
      skill_profile: skillProfileSchema,
      npm_package: z.string().optional(),
      capture: z.boolean().optional(),
      capture_local_private: z.boolean().optional(),
      manifest_path: z.string().optional(),
      explain_ranking: z.boolean().optional(),
      resume_run_id: z.string().optional()
    }
  }, async (input) => withToolErrors('hunt', async () => {
    const parsed = parseToolInput(HuntInputSchema, input);
    if (parsed.resume_run_id) {
      return stamp('hunt')(await hunt({ resume_run_id: parsed.resume_run_id }));
    }
    const resolved = resolveHuntFromConfig(parsed, await loadEffectiveConfig({ input: parsed }));
    if (!captureRequested(parsed)) return stamp('hunt')(await hunt(resolved));
    const mode = captureMode(parsed);
    const target = resolved.repo
      ? await captureTargetForRepo({ repo: resolved.repo, capture_mode: mode })
      : captureTargetForOrg(resolved.org!);
    const captured = await withCaptureSession({
      command: 'hunt',
      capture_mode: mode,
      target,
      source: { surface: 'mcp', attribution: 'hunt capture' }
    }, async (session) => {
      const stamped = stamp('hunt')(await hunt({ ...resolved, capture_persist_checks: true })) as Record<string, unknown>;
      session.linkRun({
        run_id: typeof stamped.run_id === 'string' ? stamped.run_id : undefined,
        decision_ids: extractHuntDecisionIds(stamped)
      });
      return stamped;
    });
    const manifest = await putCaptureManifest(captured.manifest);
    return withCaptureOutput(captured.value, manifest);
  }));
  server.registerTool('list_probe_templates', { title: 'List probe templates', inputSchema: {} }, async () => withToolErrors('probes', async () => ({
    verdict_summary: `listed ${listProbeTemplates().length} probe templates.`,
    evidence: listProbeTemplates(),
    checked: ['listed built-in probe templates'],
    not_checked: ['probe templates are heuristics; they do not prove an issue-specific fix shipped.'],
    signals: [],
    cached: false,
    fetched_at: new Date().toISOString()
  }), stamp('probes')));
  server.registerTool('ledger_lookup', { title: 'Ledger lookup', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) =>
    withToolErrors('ledger_lookup', () => ledger_lookup(parseToolInput(LedgerLookupInputSchema, input)), stamp('ledger_lookup')));
  server.registerTool('ledger_record', { title: 'Ledger record', inputSchema: { repo: z.string(), issue_number: z.number(), verdict: z.string().optional(), disposition: z.string().optional(), quality_score: z.number().optional(), notes: z.string().optional(), source: z.string().optional() } }, async (input) =>
    withToolErrors('ledger_record', () => ledger_record(parseToolInput(LedgerRecordInputSchema, input)), stamp('ledger_record')));
  server.registerTool('ledger_list', { title: 'Ledger list', inputSchema: { repo: z.string().optional(), limit: z.number().optional() } }, async (input) =>
    withToolErrors('ledger_list', () => ledger_list(parseToolInput(LedgerListInputSchema, input)), stamp('ledger_list')));
  server.registerTool('store_migrate_ledger', { title: 'Migrate legacy ledger', inputSchema: { force: z.boolean().optional() } }, async (input) =>
    withToolErrors('store_migrate_ledger', () => store_migrate_ledger({ force: input?.force === true }), stamp('store_migrate_ledger')));
  server.registerTool('store_rebuild_indexes', { title: 'Rebuild store indexes', inputSchema: {} }, async () =>
    withToolErrors('store_rebuild_indexes', () => store_rebuild_indexes(), stamp('store_rebuild_indexes')));
  server.registerTool('store_target_show', { title: 'Show store target', inputSchema: { repo: z.string(), issue_number: z.number() } }, async (input) =>
    withToolErrors('store_target_show', () => store_target_show({ repo: input.repo, issue_number: input.issue_number }), stamp('store_target_show')));
  server.registerTool('store_decision_list', { title: 'List store decisions', inputSchema: { repo: z.string().optional(), issue_number: z.number().optional(), limit: z.number().optional() } }, async (input) =>
    withToolErrors('store_decision_list', () => store_decision_list(input ?? {}), stamp('store_decision_list')));
  server.registerTool('store_outcome_record', { title: 'Record outcome event', inputSchema: { repo: z.string(), issue_number: z.number(), event: z.string(), decision_id: z.string().optional(), run_id: z.string().optional(), notes: z.string().optional() } }, async (input) =>
    withToolErrors('store_outcome_record', () => store_outcome_record(input), stamp('store_outcome_record')));
  server.registerTool('store_recheck', { title: 'Recheck target', inputSchema: { repo: z.string(), issue_number: z.number(), npm_package: z.string().optional() } }, async (input) =>
    withToolErrors('store_recheck', () => store_recheck(input), stamp('store_recheck')));
  server.registerTool('store_export', { title: 'Export store slice', inputSchema: { out_dir: z.string(), repo: z.string().optional(), issue_number: z.number().optional() } }, async (input) =>
    withToolErrors('store_export', () => store_export(input), stamp('store_export')));
  server.registerTool('capture_show', { title: 'Show capture', inputSchema: { capture_id: z.string() } }, async (input) =>
    withToolErrors('capture_show', () => capture_show(parseToolInput(CaptureShowInputSchema, input)), stamp('capture_show')));
  server.registerTool('capture_list', { title: 'List captures', inputSchema: { limit: z.number().optional() } }, async (input) =>
    withToolErrors('capture_list', () => capture_list(parseToolInput(CaptureListInputSchema, input)), stamp('capture_list')));
  server.registerTool('case_promote', { title: 'Promote capture to proposed case fixture', inputSchema: { capture_id: z.string(), verdict: z.string(), disposition: z.string(), adjudicator_rationale: z.string(), evidence_urls: z.array(z.string()), out_path: z.string(), force: z.boolean().optional() } }, async (input) =>
    withToolErrors('case_promote', () => case_promote(parseToolInput(CasePromoteInputSchema, input)), stamp('case_promote')));
  server.registerTool('brief_show', { title: 'Show stored decision brief', inputSchema: { decision_id: z.string(), config_path: z.string().optional(), cwd: z.string().optional() } }, async (input) =>
    withToolErrors('brief', () => generateBrief(parseToolInput(BriefShowInputSchema, input))));
  server.registerTool('brief', { title: 'Brief stored decision', inputSchema: { decision_id: z.string(), config_path: z.string().optional(), cwd: z.string().optional() } }, async (input) =>
    withToolErrors('brief', () => generateBrief(parseToolInput(BriefShowInputSchema, input))));
  return server;
}

/** Default local transport: stdio (Cursor desktop / `npx gitworthy mcp`). */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { startHttpMcpServer, resolveHttpMcpListenOptions, httpMcpStartupMessage } from './http-server.js';
export { handleMcpHttpRequest } from './http-handler.js';
export {
  MCP_TOKEN_ENV,
  assertHttpBindAllowed,
  authorizeMcpRequest,
  isLoopbackHost,
  requiresMcpTokenForBind,
  resolveMcpToken
} from './auth.js';
