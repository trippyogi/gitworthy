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
  portfolio,
  pr_scan,
  watch_add,
  watch_list,
  watch_show,
  watch_recheck,
  watch_remove,
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
  store_outcome_reconcile,
  store_outcome_backfill,
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
import { withRunBudget, createRunBudget } from '../lib/run-budget.js';
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
  PortfolioInputSchema,
  PrScanInputSchema,
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
import { toolConfig } from './tool-meta.js';

function jsonText(value: unknown, isError = false) {
  const structuredContent = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
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
    // Stamp/map inside the budget so mergeBudgetMetrics still sees active counters.
    const value = await withRunBudget(createRunBudget(), async () => {
      const result = await run();
      return map ? map(result) : result;
    });
    return jsonText(value);
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
  server.registerTool('doctor', toolConfig('doctor', { probe_repo: z.string().optional(), probe_issue_number: z.number().optional(), full: z.boolean().optional() }), async (input) =>
    withToolErrors('doctor', () => doctor(parseToolInput(DoctorInputSchema, input)), stamp('doctor')));
  server.registerTool('branch_scan', toolConfig('branch_scan', { repo: z.string(), keywords: z.array(z.string()), issue_number: z.number().optional(), max_age_days: z.number().optional(), force_refresh: z.boolean().optional() }), async (input) =>
    withToolErrors('branch_scan', () => branch_scan(parseToolInput(BranchScanInputSchema, input)), stamp('branch_scan')));
  server.registerTool('issue_vs_main', toolConfig('issue_vs_main', { repo: z.string(), issue_number: z.number() }), async (input) =>
    withToolErrors('issue_vs_main', () => issue_vs_main(parseToolInput(IssueVsMainInputSchema, input)), stamp('issue_vs_main')));
  server.registerTool('release_gap', toolConfig('release_gap', { repo: z.string(), npm_package: z.string(), probe: z.object(probeShape).optional(), probe_template: z.string().optional(), force_refresh: z.boolean().optional() }), async (input) =>
    withToolErrors('release_gap', () => release_gap(parseToolInput(ReleaseGapInputSchema, input)), stamp('release_gap')));
  server.registerTool('dupe_cluster', toolConfig('dupe_cluster', { repo: z.string(), issue_number: z.number(), max_candidates: z.number().optional() }), async (input) =>
    withToolErrors('dupe_cluster', () => dupe_cluster(parseToolInput(DupeClusterInputSchema, input)), stamp('dupe_cluster')));
  server.registerTool('related_cluster', toolConfig('related_cluster', { repo: z.string(), issue_number: z.number().optional(), label: z.string().optional(), keywords: z.array(z.string()).optional(), limit: z.number().optional(), min_score: z.number().optional() }), async (input) =>
    withToolErrors('related_cluster', () => related_cluster(parseToolInput(RelatedClusterInputSchema, input)), stamp('related_cluster')));
  server.registerTool('linked_work', toolConfig('linked_work', { repo: z.string(), issue_number: z.number() }), async (input) =>
    withToolErrors('linked_work', () => linked_work(parseToolInput(LinkedWorkInputSchema, input)), stamp('linked_work')));
  server.registerTool('contention', toolConfig('contention', { repo: z.string(), issue_number: z.number(), include_diffs: z.boolean().optional(), include_gaps: z.boolean().optional(), budget_bytes: z.number().optional() }), async (input) =>
    withToolErrors('contention', () => contention(parseToolInput(ContentionInputSchema, input)), stamp('contention')));
  server.registerTool('scope_check', toolConfig('scope_check', { repo: z.string(), issue_number: z.number(), diff_path: z.string().optional(), diff_cwd: z.string().optional(), base_ref: z.string().optional() }), async (input) =>
    withToolErrors('scope_check', () => check_scope(parseToolInput(ScopeCheckInputSchema, input)), stamp('scope_check')));
  server.registerTool('contrib_policy', toolConfig('contrib_policy', { repo: z.string(), force_refresh: z.boolean().optional() }), async (input) =>
    withToolErrors('contrib_policy', () => contrib_policy(parseToolInput(ContribPolicyInputSchema, input)), stamp('contrib_policy')));
  server.registerTool('config_validate', toolConfig('config_validate', { path: z.string().optional(), user: z.boolean().optional(), repo: z.boolean().optional(), manifest_path: z.string().optional() }), async (input) =>
    withToolErrors('config_validate', () => validateConfigSelection(parseToolInput(ConfigValidateInputSchema, input)), (value) => ({
      command: 'config_validate',
      verdict_summary: 'config validation complete',
      ...value,
      checked: ['validated selected config file(s) and target manifest(s)'],
      not_checked: ['tokens are not read from config; use GITHUB_TOKEN or GH_TOKEN environment variables.']
    })));
  server.registerTool('config_show', toolConfig('config_show', { effective: z.boolean().optional(), path: z.string().optional(), cwd: z.string().optional() }), async (input) =>
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
  server.registerTool('profile_show', toolConfig('profile_show', { path: z.string().optional(), cwd: z.string().optional() }), async (input) =>
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
  server.registerTool('worth_check', toolConfig('worth_check', { repo: z.string(), issue_number: z.number(), npm_package: z.string().optional(), probe: z.object(probeShape).optional(), probe_template: z.string().optional(), capture: z.boolean().optional(), capture_local_private: z.boolean().optional() }), async (input) =>
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
  server.registerTool('scan', toolConfig('scan', { repo: z.string(), label: z.string().optional(), keywords: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional(), land_hints: z.boolean().optional(), skill_profile: skillProfileSchema, manifest_path: z.string().optional(), max_pages: z.number().optional(), explain_ranking: z.boolean().optional() }), async (input) =>
    withToolErrors('scan', async () => {
      const parsed = parseToolInput(ScanInputSchema, input);
      return scan(resolveScanFromConfig(parsed, await loadEffectiveConfig({ input: parsed })));
    }, stamp('scan')));
  server.registerTool('org_scan', toolConfig('org_scan', { org: z.string().optional(), label: z.string().optional(), keywords: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional(), max_repos: z.number().optional(), land_hints: z.boolean().optional(), skill_profile: skillProfileSchema, manifest_path: z.string().optional(), max_pages: z.number().optional(), explain_ranking: z.boolean().optional() }), async (input) =>
    withToolErrors('org_scan', async () => {
      const parsed = parseToolInput(OrgScanInputSchema, input);
      return org_scan(resolveOrgFromConfig(parsed, await loadEffectiveConfig({ input: parsed })));
    }, stamp('org_scan')));
  server.registerTool('hunt', toolConfig('hunt', {
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
  }), async (input) => withToolErrors('hunt', async () => {
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
  server.registerTool('list_probe_templates', toolConfig('list_probe_templates', {}), async () => withToolErrors('probes', async () => ({
    verdict_summary: `listed ${listProbeTemplates().length} probe templates.`,
    evidence: listProbeTemplates(),
    checked: ['listed built-in probe templates'],
    not_checked: ['probe templates are heuristics; they do not prove an issue-specific fix shipped.'],
    signals: [],
    cached: false,
    fetched_at: new Date().toISOString()
  }), stamp('probes')));
  server.registerTool('ledger_lookup', toolConfig('ledger_lookup', { repo: z.string(), issue_number: z.number() }), async (input) =>
    withToolErrors('ledger_lookup', () => ledger_lookup(parseToolInput(LedgerLookupInputSchema, input)), stamp('ledger_lookup')));
  server.registerTool('ledger_record', toolConfig('ledger_record', { repo: z.string(), issue_number: z.number(), verdict: z.string().optional(), disposition: z.string().optional(), quality_score: z.number().optional(), notes: z.string().optional(), source: z.string().optional() }), async (input) =>
    withToolErrors('ledger_record', () => ledger_record(parseToolInput(LedgerRecordInputSchema, input)), stamp('ledger_record')));
  server.registerTool('ledger_list', toolConfig('ledger_list', { repo: z.string().optional(), limit: z.number().optional() }), async (input) =>
    withToolErrors('ledger_list', () => ledger_list(parseToolInput(LedgerListInputSchema, input)), stamp('ledger_list')));
  server.registerTool('store_migrate_ledger', toolConfig('store_migrate_ledger', { force: z.boolean().optional() }), async (input) =>
    withToolErrors('store_migrate_ledger', () => store_migrate_ledger({ force: input?.force === true }), stamp('store_migrate_ledger')));
  server.registerTool('store_rebuild_indexes', toolConfig('store_rebuild_indexes', {}), async () =>
    withToolErrors('store_rebuild_indexes', () => store_rebuild_indexes(), stamp('store_rebuild_indexes')));
  server.registerTool('store_target_show', toolConfig('store_target_show', { repo: z.string(), issue_number: z.number() }), async (input) =>
    withToolErrors('store_target_show', () => store_target_show({ repo: input.repo, issue_number: input.issue_number }), stamp('store_target_show')));
  server.registerTool('store_decision_list', toolConfig('store_decision_list', { repo: z.string().optional(), issue_number: z.number().optional(), limit: z.number().optional() }), async (input) =>
    withToolErrors('store_decision_list', () => store_decision_list(input ?? {}), stamp('store_decision_list')));
  server.registerTool('store_outcome_record', toolConfig('store_outcome_record', {
    repo: z.string(),
    issue_number: z.number(),
    event: z.string(),
    decision_id: z.string().optional(),
    run_id: z.string().optional(),
    notes: z.string().optional(),
    close_reason: z.string().optional(),
    acted_against_skip: z.boolean().optional(),
    pr_url: z.string().optional()
  }), async (input) =>
    withToolErrors('store_outcome_record', () => store_outcome_record(input), stamp('store_outcome_record')));
  server.registerTool('store_outcome_reconcile', toolConfig('store_outcome_reconcile', {
    dry_run: z.boolean().optional(),
    write: z.boolean().optional(),
    repo: z.string().optional(),
    issue_number: z.number().optional(),
    author: z.string().optional()
  }), async (input) =>
    withToolErrors('store_outcome_reconcile', () => store_outcome_reconcile(input ?? {}), stamp('store_outcome_reconcile')));
  server.registerTool('store_outcome_backfill', toolConfig('store_outcome_backfill', {
    dry_run: z.boolean().optional(),
    write: z.boolean().optional(),
    author: z.string().optional()
  }), async (input) =>
    withToolErrors('store_outcome_backfill', () => store_outcome_backfill(input ?? {}), stamp('store_outcome_backfill')));
  server.registerTool('store_recheck', toolConfig('store_recheck', { repo: z.string(), issue_number: z.number(), npm_package: z.string().optional() }), async (input) =>
    withToolErrors('store_recheck', () => store_recheck(input), stamp('store_recheck')));
  server.registerTool('store_export', toolConfig('store_export', { out_dir: z.string(), repo: z.string().optional(), issue_number: z.number().optional() }), async (input) =>
    withToolErrors('store_export', () => store_export(input), stamp('store_export')));
  server.registerTool('capture_show', toolConfig('capture_show', { capture_id: z.string() }), async (input) =>
    withToolErrors('capture_show', () => capture_show(parseToolInput(CaptureShowInputSchema, input)), stamp('capture_show')));
  server.registerTool('capture_list', toolConfig('capture_list', { limit: z.number().optional() }), async (input) =>
    withToolErrors('capture_list', () => capture_list(parseToolInput(CaptureListInputSchema, input)), stamp('capture_list')));
  server.registerTool('case_promote', toolConfig('case_promote', { capture_id: z.string(), verdict: z.string(), disposition: z.string(), adjudicator_rationale: z.string(), evidence_urls: z.array(z.string()), out_path: z.string(), force: z.boolean().optional() }), async (input) =>
    withToolErrors('case_promote', () => case_promote(parseToolInput(CasePromoteInputSchema, input)), stamp('case_promote')));
  server.registerTool('brief_show', toolConfig('brief_show', { decision_id: z.string(), config_path: z.string().optional(), cwd: z.string().optional() }), async (input) =>
    withToolErrors('brief', () => generateBrief(parseToolInput(BriefShowInputSchema, input))));
  server.registerTool('brief', toolConfig('brief', { decision_id: z.string(), config_path: z.string().optional(), cwd: z.string().optional() }), async (input) =>
    withToolErrors('brief', () => generateBrief(parseToolInput(BriefShowInputSchema, input))));
  server.registerTool('watch_add', toolConfig('watch_add', {
    repo: z.string(),
    issue_number: z.number().optional(),
    pr_number: z.number().optional(),
    note: z.string().optional()
  }), async (input) => withToolErrors('watch_add', async () => stamp('watch_add')(await watch_add(input as { repo: string; issue_number?: number; pr_number?: number; note?: string }))));
  server.registerTool('watch_list', toolConfig('watch_list', {}), async () =>
    withToolErrors('watch_list', async () => stamp('watch_list')(await watch_list())));
  server.registerTool('watch_show', toolConfig('watch_show', { watch_id: z.string() }), async (input) =>
    withToolErrors('watch_show', async () => stamp('watch_show')(await watch_show(String((input as { watch_id: string }).watch_id)))));
  server.registerTool('watch_recheck', toolConfig('watch_recheck', { watch_id: z.string(), write: z.boolean().optional() }), async (input) =>
    withToolErrors('watch_recheck', async () => stamp('watch_recheck')(await watch_recheck(input as { watch_id: string; write?: boolean }))));
  server.registerTool('watch_remove', toolConfig('watch_remove', { watch_id: z.string() }), async (input) =>
    withToolErrors('watch_remove', async () => stamp('watch_remove')(await watch_remove(String((input as { watch_id: string }).watch_id)))));
  server.registerTool('portfolio', toolConfig('portfolio', {
    repo: z.string().optional(),
    org: z.string().optional(),
    label: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    since: z.string().optional(),
    scan_limit: z.number().optional(),
    max_repos: z.number().optional(),
    max_checks: z.number().optional(),
    max_items: z.number().optional(),
    include_watch: z.boolean().optional(),
    include_prs: z.boolean().optional(),
    skill_profile: skillProfileSchema
  }), async (input) => withToolErrors('portfolio', async () => {
    const parsed = parseToolInput(PortfolioInputSchema, input);
    const effective = await loadEffectiveConfig({
      input: { repo: parsed.repo, org: parsed.org }
    });
    return stamp('portfolio')(await portfolio({
      ...parsed,
      skill_profile: typeof parsed.skill_profile === 'string' ? parsed.skill_profile : undefined,
      contribution_profile: effective.values.contribution_profile
    }));
  }));
  server.registerTool('pr_scan', toolConfig('pr_scan', {
    repo: z.string(),
    include_bots: z.boolean().optional(),
    include_merged: z.boolean().optional(),
    include_drafts: z.boolean().optional(),
    include_generated: z.boolean().optional(),
    stale_pr_days: z.number().optional(),
    inventory_limit: z.number().optional(),
    enrich_limit: z.number().optional()
  }), async (input) => withToolErrors('pr_scan', async () => {
    return stamp('pr_scan')(await pr_scan(parseToolInput(PrScanInputSchema, input)));
  }));
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
