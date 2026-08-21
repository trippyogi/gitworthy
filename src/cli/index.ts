#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
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
  resumeHunt,
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
  renderBrief,
  release_gap,
  scan,
  store_decision_list,
  store_decision_show,
  store_export,
  store_migrate_ledger,
  store_outcome_list,
  store_outcome_record,
  store_outcome_reconcile,
  store_outcome_backfill,
  store_outcome_show,
  store_recheck,
  store_rebuild_indexes,
  store_run_list,
  store_run_show,
  store_target_show,
  worth_check
} from '../core/index.js';
import { GitworthyError } from '../core/envelope.js';
import { packageVersion } from '../lib/package-meta.js';
import { enterRunBudget } from '../lib/run-budget.js';
import { progress, renderHuman } from './render-human.js';
import {
  assertEffectiveConfigSafeToShow,
  loadEffectiveConfig,
  profileForShow,
  resolveHuntFromConfig,
  resolveOrgFromConfig,
  resolveScanFromConfig,
  validateConfigSelection,
  writeConfigSkeleton
} from '../lib/config.js';
import {
  ConfigValidateInputSchema,
  DispositionSchema,
  BriefFormatSchema,
  IssueNumberStringSchema,
  OrgOrUserLoginSchema,
  RepoRefSchema,
  VerdictSchema,
  parseArg,
  parseIssueRef,
  parseToolInput,
  PortfolioInputSchema,
  PrScanInputSchema,
  toCheckResult,
  toErrorResult,
  toStampedLegacyResult
} from '../contracts/index.js';
import { persistCheckResultBestEffort } from '../lib/store.js';
import { captureTargetForOrg, captureTargetForRepo, captureTargetForRepoIssue } from '../lib/capture-policy.js';
import { putCaptureManifest } from '../lib/capture-store.js';
import { withCaptureSession } from '../lib/capture-session.js';
import {
  httpMcpStartupMessage,
  startHttpMcpServer,
  startMcpServer
} from '../mcp/server.js';

const help = `gitworthy

Usage:
  gitworthy --help
  gitworthy --version
  gitworthy [--quiet|-q] [--verbose|-v] <command> …
  gitworthy doctor [--full] [--json]
  gitworthy init [--user] [--repo] [--overwrite] [--json]
  gitworthy config validate [--path path] [--manifest path] [--user] [--repo] [--json]
  gitworthy config show --effective [--path path] [--json]
  gitworthy profile show [--path path] [--json]
  gitworthy check owner/repo#123 [--npm-package name] [--probe-glob glob] [--probe-contains text] [--probe-template id] [--capture] [--capture-local-private] [--json]
  gitworthy hunt owner/repo|org [--manifest path] [--max-checks 3] [--label ...] [--keywords ...] [--since 90d] [--limit 25] [--max-repos 8] [--max-pages 1] [--skill-profile ...] [--explain-ranking] [--skip-policy-gate] [--no-land-hints] [--capture] [--capture-local-private] [--json]
  gitworthy portfolio owner/repo|org [--org] [--max-checks 3] [--max-items 10] [--include-watch] [--no-prs] [--label ...] [--keywords ...] [--json]
  gitworthy prs owner/repo [--include-bots] [--include-merged] [--json]
  gitworthy watch add owner/repo#123|--pr N [--note text] [--json]
  gitworthy watch list|show|recheck|remove <watch_id> [--json]
  gitworthy branches owner/repo keyword[,keyword] [--json] [--force-refresh]
  gitworthy issue owner/repo 123 [--json]
  gitworthy release owner/repo package-name [--probe-glob glob] [--probe-contains text] [--probe-template id] [--json]
  gitworthy dupes owner/repo 123 [--json]
  gitworthy related owner/repo [123] [--label ...] [--keywords ...] [--limit 40] [--json]
  gitworthy linked owner/repo 123 [--json]
  gitworthy contention owner/repo 123 [--no-diffs] [--no-gaps] [--json]
  gitworthy check-scope owner/repo 123 [--diff path] [--base-ref ref] [--json]
  gitworthy policy owner/repo [--json]
  gitworthy scan owner/repo [--label "good first issue"] [--keywords term,term] [--since 90d] [--limit 25] [--max-pages 1] [--skill-profile ...] [--explain-ranking] [--no-land-hints] [--json]
  gitworthy org org-or-user [--manifest path] [--label ...] [--keywords ...] [--since 90d] [--limit 25] [--max-repos 8] [--max-pages 1] [--skill-profile ...] [--explain-ranking] [--no-land-hints] [--json]
  gitworthy probes [--json]
  gitworthy ledger list [--repo owner/repo] [--limit 50] [--json]
  gitworthy ledger show owner/repo#123 [--json]
  gitworthy ledger record owner/repo#123 [--verdict ACT] [--disposition greenfield] [--notes text] [--json]
  gitworthy ledger migrate [--force] [--json]
  gitworthy store rebuild-indexes [--json]
  gitworthy store target owner/repo#123 [--json]
  gitworthy store export [--repo owner/repo] [--issue 123] --out-dir path [--json]
  gitworthy run show <run_id> [--json]
  gitworthy run resume <run_id> [--json]
  gitworthy run list [--repo owner/repo] [--issue 123] [--limit 50] [--json]
  gitworthy decision show <decision_id> [--json]
  gitworthy decision list [--repo owner/repo] [--issue 123] [--limit 50] [--json]
  gitworthy outcome show <event_id> [--json]
  gitworthy outcome list [--repo owner/repo] [--issue 123] [--limit 50] [--json]
  gitworthy outcome record owner/repo#123 --event selected [--decision-id id] [--run-id id] [--notes text] [--close-reason superseded|stale|withdrawn] [--acted-against-skip] [--pr-url url] [--json]
  gitworthy outcome reconcile [--repo owner/repo] [--issue 123] [--author @me] [--write] [--json]
  gitworthy outcome backfill [--author @me] [--write] [--json]
  gitworthy capture list [--limit 50] [--json]
  gitworthy capture show <capture_id> [--json]
  gitworthy case promote <capture_id> --verdict ACT --disposition greenfield --rationale text --evidence-url url --out path [--force] [--json]
  gitworthy brief <decision_id> [--format human|json|markdown] [--out file] [--json]
  gitworthy recheck owner/repo#123 [--npm-package name] [--json]
  gitworthy mcp
  gitworthy mcp --http [--host 127.0.0.1] [--port 8787] [--path /mcp] [--stateless]
`;

type Write = (text: string) => void;

/** Every CLI input-validation failure is a GitworthyError with a stable code, never a bare Error. */
function usageError(message: string): never {
  throw new GitworthyError({ code: 'invalid_usage', message, not_checked: [message] });
}

function toCliError(error: unknown): GitworthyError {
  if (error instanceof GitworthyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new GitworthyError({ code: 'invalid_usage', message, not_checked: [message] });
}

function required(value: string | undefined, usage: string): string {
  if (!value) usageError(usage);
  return value;
}

function repoArg(value: string | undefined, usage: string): string {
  return parseArg(RepoRefSchema, required(value, usage), 'invalid_repo_ref');
}

function orgArg(value: string | undefined, usage: string): string {
  return parseArg(OrgOrUserLoginSchema, required(value, usage), 'invalid_org_ref');
}

function issueNumberArg(value: string | undefined, usage: string): number {
  return parseArg(IssueNumberStringSchema, required(value, usage), 'invalid_issue_number');
}

function print(output: unknown, asJson: boolean, write: Write, options: { verbose?: boolean } = {}): void {
  if (asJson) write(`${JSON.stringify(output, null, 2)}\n`);
  else write(renderHuman(output, { verbose: options.verbose }));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function captureRequested(values: Record<string, unknown>): boolean {
  return values.capture === true || values['capture-local-private'] === true;
}

function captureMode(values: Record<string, unknown>): 'public' | 'local_only' {
  return values['capture-local-private'] === true ? 'local_only' : 'public';
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

function probe(values: { 'probe-glob'?: unknown; 'probe-contains'?: unknown }): { file_glob?: string; contains?: string } | undefined {
  const file_glob = stringValue(values['probe-glob']);
  const contains = stringValue(values['probe-contains']);
  if (!file_glob && !contains) return undefined;
  return { file_glob, contains };
}

function exitFor(output: unknown): number {
  const value = output as { verdict?: string };
  if (value.verdict === 'ACT') return 0;
  if (value.verdict === 'VERIFY') return 10;
  if (value.verdict === 'SKIP') return 20;
  return 0;
}

function scanFilters(values: Record<string, unknown>) {
  const maxPagesRaw = stringValue(values['max-pages']);
  const maxPages = maxPagesRaw ? Number(maxPagesRaw) : undefined;
  if (maxPagesRaw && (!Number.isFinite(maxPages) || (maxPages as number) < 1)) {
    usageError('--max-pages must be a positive number.');
  }
  return {
    label: stringValue(values.label),
    keywords: stringValue(values.keywords)?.split(',').filter(Boolean),
    since: stringValue(values.since),
    limit: stringValue(values.limit) ? Number(stringValue(values.limit)) : undefined,
    land_hints: values['no-land-hints'] === true ? false : undefined,
    skill_profile: stringValue(values['skill-profile']),
    manifest_path: stringValue(values.manifest),
    max_pages: maxPages,
    explain_ranking: values['explain-ranking'] === true ? true : undefined
  };
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

const CLI_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v' },
  full: { type: 'boolean' },
  'npm-package': { type: 'string' },
  'probe-glob': { type: 'string' },
  'probe-contains': { type: 'string' },
  'probe-template': { type: 'string' },
  'skill-profile': { type: 'string' },
  manifest: { type: 'string' },
  path: { type: 'string' },
  effective: { type: 'boolean' },
  user: { type: 'boolean' },
  overwrite: { type: 'boolean' },
  'skip-policy-gate': { type: 'boolean' },
  'force-refresh': { type: 'boolean' },
  'no-diffs': { type: 'boolean' },
  'no-gaps': { type: 'boolean' },
  diff: { type: 'string' },
  'base-ref': { type: 'string' },
  label: { type: 'string' },
  keywords: { type: 'string' },
  since: { type: 'string' },
  limit: { type: 'string' },
  'max-repos': { type: 'string' },
  'max-pages': { type: 'string' },
  'max-checks': { type: 'string' },
  'max-items': { type: 'string' },
  'include-watch': { type: 'boolean' },
  'no-prs': { type: 'boolean' },
  'include-bots': { type: 'boolean' },
  'include-merged': { type: 'boolean' },
  pr: { type: 'string' },
  note: { type: 'string' },
  'explain-ranking': { type: 'boolean' },
  'no-land-hints': { type: 'boolean' },
  capture: { type: 'boolean' },
  'capture-local-private': { type: 'boolean' },
  repo: { type: 'string' },
  org: { type: 'boolean' },
  verdict: { type: 'string' },
  disposition: { type: 'string' },
  notes: { type: 'string' },
  force: { type: 'boolean' },
  event: { type: 'string' },
  'decision-id': { type: 'string' },
  'run-id': { type: 'string' },
  'close-reason': { type: 'string' },
  'acted-against-skip': { type: 'boolean' },
  'pr-url': { type: 'string' },
  write: { type: 'boolean' },
  author: { type: 'string' },
  'out-dir': { type: 'string' },
  out: { type: 'string' },
  rationale: { type: 'string' },
  'evidence-url': { type: 'string', multiple: true },
  format: { type: 'string' },
  issue: { type: 'string' },
  http: { type: 'boolean' },
  host: { type: 'string' },
  port: { type: 'string' },
  stateless: { type: 'boolean' }
} as const;

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: CLI_OPTIONS
  });
}

export async function runCli(argv = process.argv.slice(2), stdout: Write = (text) => process.stdout.write(text), stderr: Write = (text) => process.stderr.write(text)): Promise<number> {
  const asJsonEarly = argv.includes('--json');
  if (argv[0] === 'init') {
    try {
      const parsedInit = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        strict: true,
        options: { json: { type: 'boolean' }, user: { type: 'boolean' }, repo: { type: 'boolean' }, overwrite: { type: 'boolean' } }
      });
      if (parsedInit.positionals.length > 0) usageError('init does not accept positional arguments.');
      const targets: Array<'user' | 'repo'> = [];
      if (parsedInit.values.user === true) targets.push('user');
      if (parsedInit.values.repo === true || targets.length === 0) targets.push('repo');
      const files = [];
      for (const target of targets) files.push({ target, ...await writeConfigSkeleton(target, parsedInit.values.overwrite === true) });
      print({
        command: 'init',
        verdict_summary: `initialized ${files.filter((file) => file.created).length} config file(s)`,
        files,
        checked: ['wrote secret-free config skeleton(s)'],
        not_checked: ['tokens are never persisted; set GITHUB_TOKEN or GH_TOKEN in the environment when needed.']
      }, parsedInit.values.json === true, stdout);
      return 0;
    } catch (error) {
      const structured = toErrorResult({ command: 'init', error: toCliError(error) });
      if (asJsonEarly) stdout(`${JSON.stringify(structured, null, 2)}\n`);
      else stderr(`${structured.error.message}\n`);
      return structured.error.category === 'input' ? 2 : 1;
    }
  }
  if (argv[0] === 'config') {
    try {
      const parsedConfig = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        strict: true,
        options: { json: { type: 'boolean' }, path: { type: 'string' }, manifest: { type: 'string' }, user: { type: 'boolean' }, repo: { type: 'boolean' }, effective: { type: 'boolean' } }
      });
      const [action] = parsedConfig.positionals;
      let output: unknown;
      if (action === 'validate') {
        output = {
          command: 'config_validate',
          verdict_summary: 'config validation complete',
          ...await validateConfigSelection(parseToolInput(ConfigValidateInputSchema, {
            path: stringValue(parsedConfig.values.path),
            user: parsedConfig.values.user === true ? true : undefined,
            repo: parsedConfig.values.repo === true ? true : undefined,
            manifest_path: stringValue(parsedConfig.values.manifest)
          })),
          checked: ['validated selected config file(s) and target manifest(s)'],
          not_checked: ['tokens are not read from config; use GITHUB_TOKEN or GH_TOKEN environment variables.']
        };
      } else if (action === 'show') {
        if (parsedConfig.values.effective !== true) usageError('config show currently requires --effective.');
        const effective = await loadEffectiveConfig({ userPath: stringValue(parsedConfig.values.path) });
        assertEffectiveConfigSafeToShow(effective);
        output = {
          command: 'config_show',
          verdict_summary: 'resolved effective config',
          effective: true,
          values: effective.values,
          provenance: effective.provenance,
          paths: effective.paths,
          loaded: effective.loaded,
          checked: ['resolved config precedence: input > env > repo > user > defaults'],
          not_checked: ['secret values are not shown; GitHub tokens remain env-only via GITHUB_TOKEN or GH_TOKEN.']
        };
      } else {
        usageError('config requires validate or show.');
      }
      print(output, parsedConfig.values.json === true, stdout);
      return 0;
    } catch (error) {
      const structured = toErrorResult({ command: 'config', error: toCliError(error) });
      if (asJsonEarly) stdout(`${JSON.stringify(structured, null, 2)}\n`);
      else stderr(`${structured.error.message}\n`);
      return structured.error.category === 'input' ? 2 : 1;
    }
  }
  if (argv[0] === 'profile') {
    try {
      const parsedProfile = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        strict: true,
        options: { json: { type: 'boolean' }, path: { type: 'string' } }
      });
      if (parsedProfile.positionals[0] !== 'show') usageError('profile requires show.');
      const effective = await loadEffectiveConfig({ userPath: stringValue(parsedProfile.values.path) });
      assertEffectiveConfigSafeToShow(effective);
      const profile = profileForShow(effective);
      print({
        command: 'profile_show',
        verdict_summary: profile ? 'resolved skill profile' : 'no skill profile configured',
        profile,
        provenance: profile ? effective.provenance.skill_profile ?? null : null,
        checked: ['resolved skill profile from config precedence'],
        not_checked: ['skill profile affects scan/hunt ranking inputs only; it never changes hard verdict policy.']
      }, parsedProfile.values.json === true, stdout);
      return 0;
    } catch (error) {
      const structured = toErrorResult({ command: 'profile_show', error: toCliError(error) });
      if (asJsonEarly) stdout(`${JSON.stringify(structured, null, 2)}\n`);
      else stderr(`${structured.error.message}\n`);
      return structured.error.category === 'input' ? 2 : 1;
    }
  }
  if (argv[0] === 'branches' && argv[2]?.startsWith('-')) {
    try {
      enterRunBudget();
      const repo = repoArg(argv[1], 'branches requires owner/repo and keywords.');
      const second = required(argv[2], 'branches requires owner/repo and keywords.');
      stderr(`Warning: branch keyword "${second}" starts with a dash. Use -- before positional arguments if your shell or parser treats it as an option.\n`);
      const output = toStampedLegacyResult('branch_scan', await branch_scan({
        repo,
        keywords: second.split(',').filter(Boolean),
        force_refresh: argv.includes('--force-refresh')
      }) as Record<string, unknown>);
      print(output, asJsonEarly, stdout, { verbose: argv.includes('--verbose') || argv.includes('-v') });
      return 0;
    } catch (error) {
      const structured = toErrorResult({ command: 'branch_scan', error });
      if (asJsonEarly) stdout(`${JSON.stringify(structured, null, 2)}\n`);
      else stderr(`${structured.error.message}\n`);
      return structured.error.category === 'input' ? 2 : 1;
    }
  }

  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    const structured = toErrorResult({ command: 'cli', error: toCliError(error) });
    if (asJsonEarly) stdout(`${JSON.stringify(structured, null, 2)}\n`);
    else stderr(`${structured.error.message}\n`);
    return 2;
  }

  const [command, first, second] = parsed.positionals;
  if (parsed.values.version || command === 'version') {
    stdout(`${packageVersion()}\n`);
    return 0;
  }
  if (parsed.values.help || !command) {
    stdout(help);
    return 0;
  }
  if (command === 'mcp') {
    try {
      if (parsed.values.http === true) {
        const portRaw = stringValue(parsed.values.port);
        const port = portRaw === undefined ? undefined : Number(portRaw);
        if (portRaw !== undefined && (!Number.isFinite(port) || !Number.isInteger(port) || (port as number) <= 0)) {
          usageError('mcp --http --port requires a positive integer.');
        }
        const started = await startHttpMcpServer({
          host: stringValue(parsed.values.host),
          port,
          path: stringValue(parsed.values.path),
          stateless: parsed.values.stateless === true
        });
        stderr(`${httpMcpStartupMessage(started)}\n`);
        await new Promise<void>((resolve) => {
          const shutdown = () => {
            void started.close().finally(() => resolve());
          };
          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);
        });
        return 0;
      }
      await startMcpServer();
      return 0;
    } catch (error) {
      const structured = toErrorResult({ command: 'mcp', error: toCliError(error) });
      if (asJsonEarly) stdout(`${JSON.stringify(structured, null, 2)}\n`);
      else stderr(`${structured.error.message}\n`);
      return structured.error.category === 'input' ? 2 : 1;
    }
  }
  const asJson = parsed.values.json === true;
  const quiet = parsed.values.quiet === true;
  const verbose = parsed.values.verbose === true;
  let commandName = command ?? 'unknown';
  try {
    enterRunBudget();
    if (!quiet && !asJson) progress(stderr, quiet, `gitworthy ${commandName}…`);
    let output: unknown;
    if (command === 'doctor') {
      commandName = 'doctor';
      output = toStampedLegacyResult('doctor', await doctor({
        full: parsed.values.full === true
      }) as Record<string, unknown>);
    } else if (command === 'check') {
      commandName = 'check';
      const ref = parseIssueRef(required(first, 'check requires owner/repo#123.'));
      const runCheck = async () => {
        const legacy = await worth_check({
          ...ref,
          npm_package: stringValue(parsed.values['npm-package']),
          probe: probe(parsed.values),
          probe_template: stringValue(parsed.values['probe-template'])
        });
        const check = toCheckResult(legacy as Record<string, unknown>, ref);
        await persistCheckResultBestEffort(check);
        return check;
      };
      if (captureRequested(parsed.values)) {
        const mode = captureMode(parsed.values);
        const target = await captureTargetForRepoIssue({ ...ref, capture_mode: mode });
        const captured = await withCaptureSession({
          command: 'check',
          capture_mode: mode,
          target,
          source: { surface: 'cli', attribution: 'gitworthy check --capture' }
        }, async (session) => {
          const check = await runCheck();
          session.linkRun({ run_id: check.run_id, decision_id: check.decision_id });
          return check;
        });
        const manifest = await putCaptureManifest(captured.manifest);
        output = withCaptureOutput(captured.value, manifest);
      } else {
        output = await runCheck();
      }
    } else if (command === 'branches') {
      commandName = 'branch_scan';
      const repo = repoArg(first, 'branches requires owner/repo and keywords.');
      const keywordsArg = required(second, 'branches requires owner/repo and keywords.');
      for (const keyword of keywordsArg.split(',').filter(Boolean)) if (keyword.startsWith('-')) stderr(`Warning: branch keyword "${keyword}" starts with a dash. Use -- before positional arguments if your shell or parser treats it as an option.\n`);
      output = toStampedLegacyResult('branch_scan', await branch_scan({ repo, keywords: keywordsArg.split(',').filter(Boolean), force_refresh: parsed.values['force-refresh'] === true }) as Record<string, unknown>);
    } else if (command === 'issue') {
      commandName = 'issue_vs_main';
      const repo = repoArg(first, 'issue requires owner/repo and issue number.');
      const issue_number = issueNumberArg(second, 'issue requires owner/repo and issue number.');
      output = toStampedLegacyResult('issue_vs_main', await issue_vs_main({ repo, issue_number }) as Record<string, unknown>);
    } else if (command === 'release') {
      commandName = 'release_gap';
      const repo = repoArg(first, 'release requires owner/repo and package name.');
      const npm_package = required(second, 'release requires owner/repo and package name.');
      output = toStampedLegacyResult('release_gap', await release_gap({
        repo,
        npm_package,
        probe: probe(parsed.values),
        probe_template: stringValue(parsed.values['probe-template']),
        force_refresh: parsed.values['force-refresh'] === true
      }) as Record<string, unknown>);
    } else if (command === 'dupes') {
      commandName = 'dupe_cluster';
      const repo = repoArg(first, 'dupes requires owner/repo and issue number.');
      const issue_number = issueNumberArg(second, 'dupes requires owner/repo and issue number.');
      output = toStampedLegacyResult('dupe_cluster', await dupe_cluster({ repo, issue_number }) as Record<string, unknown>);
    } else if (command === 'related') {
      commandName = 'related_cluster';
      const repo = repoArg(first, 'related requires owner/repo.');
      const filters = scanFilters(parsed.values);
      output = toStampedLegacyResult('related_cluster', await related_cluster({
        repo,
        issue_number: second ? parseArg(IssueNumberStringSchema, second, 'invalid_issue_number') : undefined,
        label: filters.label,
        keywords: filters.keywords,
        limit: filters.limit
      }) as Record<string, unknown>);
    } else if (command === 'linked') {
      commandName = 'linked_work';
      const repo = repoArg(first, 'linked requires owner/repo and issue number.');
      const issue_number = issueNumberArg(second, 'linked requires owner/repo and issue number.');
      output = toStampedLegacyResult('linked_work', await linked_work({ repo, issue_number }) as Record<string, unknown>);
    } else if (command === 'contention') {
      commandName = 'contention';
      const repo = repoArg(first, 'contention requires owner/repo and issue number.');
      const issue_number = issueNumberArg(second, 'contention requires owner/repo and issue number.');
      output = toStampedLegacyResult('contention', await contention({
        repo,
        issue_number,
        include_diffs: parsed.values['no-diffs'] === true ? false : undefined,
        include_gaps: parsed.values['no-gaps'] === true ? false : undefined
      }) as Record<string, unknown>);
    } else if (command === 'check-scope') {
      commandName = 'scope_check';
      const repo = repoArg(first, 'check-scope requires owner/repo and issue number.');
      const issue_number = issueNumberArg(second, 'check-scope requires owner/repo and issue number.');
      output = toStampedLegacyResult('scope_check', await check_scope({
        repo,
        issue_number,
        diff_path: stringValue(parsed.values.diff),
        base_ref: stringValue(parsed.values['base-ref'])
      }) as Record<string, unknown>);
    } else if (command === 'policy') {
      commandName = 'contrib_policy';
      const repo = repoArg(first, 'policy requires owner/repo.');
      output = toStampedLegacyResult('contrib_policy', await contrib_policy({ repo, force_refresh: parsed.values['force-refresh'] === true }) as Record<string, unknown>);
    } else if (command === 'portfolio') {
      commandName = 'portfolio';
      const target = first;
      if (!target) usageError('portfolio requires owner/repo or an org/user login.');
      if (parsed.values.org === true && target.includes('/')) {
        usageError('portfolio --org expects an org or user login, not owner/repo. Omit --org for a single repo.');
      }
      const asOrg = parsed.values.org === true || !target.includes('/');
      const maxChecksRaw = stringValue(parsed.values['max-checks']);
      const maxChecks = maxChecksRaw ? Number(maxChecksRaw) : undefined;
      if (maxChecksRaw && (!Number.isFinite(maxChecks) || (maxChecks as number) < 1)) {
        usageError('--max-checks must be a positive number.');
      }
      const maxItemsRaw = stringValue(parsed.values['max-items']);
      const maxItems = maxItemsRaw ? Number(maxItemsRaw) : undefined;
      if (maxItemsRaw && (!Number.isFinite(maxItems) || (maxItems as number) < 1)) {
        usageError('--max-items must be a positive number.');
      }
      const filters = scanFilters(parsed.values);
      const rawInput = compact({
        ...(asOrg
          ? { org: orgArg(target, 'portfolio requires owner/repo or an org/user login.') }
          : { repo: repoArg(target, 'portfolio requires owner/repo or an org/user login.') }),
        label: filters.label,
        keywords: filters.keywords,
        since: filters.since,
        scan_limit: filters.limit,
        max_repos: stringValue(parsed.values['max-repos']) ? Number(stringValue(parsed.values['max-repos'])) : undefined,
        max_checks: maxChecks,
        max_items: maxItems,
        include_watch: parsed.values['include-watch'] === true ? true : undefined,
        include_prs: parsed.values['no-prs'] === true ? false : undefined,
        skill_profile: filters.skill_profile
      });
      const portfolioInput = parseToolInput(PortfolioInputSchema, rawInput);
      const effective = await loadEffectiveConfig({
        input: { repo: portfolioInput.repo, org: portfolioInput.org }
      });
      output = toStampedLegacyResult('portfolio', await portfolio({
        ...portfolioInput,
        skill_profile: typeof portfolioInput.skill_profile === 'string' ? portfolioInput.skill_profile : undefined,
        contribution_profile: effective.values.contribution_profile
      }) as Record<string, unknown>);
    } else if (command === 'prs') {
      commandName = 'pr_scan';
      const repo = repoArg(first, 'prs requires owner/repo.');
      const prInput = parseToolInput(PrScanInputSchema, compact({
        repo,
        include_bots: parsed.values['include-bots'] === true ? true : undefined,
        include_merged: parsed.values['include-merged'] === true ? true : undefined
      }));
      output = toStampedLegacyResult('pr_scan', await pr_scan(prInput) as Record<string, unknown>);
    } else if (command === 'hunt') {
      commandName = 'hunt';
      const huntTarget = first;
      const maxChecksRaw = stringValue(parsed.values['max-checks']);
      const maxChecks = maxChecksRaw ? Number(maxChecksRaw) : undefined;
      if (maxChecksRaw && (!Number.isFinite(maxChecks) || (maxChecks as number) < 1)) {
        usageError('--max-checks must be a positive number.');
      }
      const maxReposRaw = stringValue(parsed.values['max-repos']);
      const maxRepos = maxReposRaw ? Number(maxReposRaw) : undefined;
      if (maxReposRaw && (!Number.isFinite(maxRepos) || (maxRepos as number) < 1)) {
        usageError('--max-repos must be a positive number.');
      }
      const filters = scanFilters(parsed.values);
      // --org forces org mode; otherwise slash ⇒ repo, no slash ⇒ org/user.
      if (parsed.values.org === true && huntTarget?.includes('/')) {
        usageError('hunt --org expects an org or user login, not owner/repo. Omit --org for a single repo.');
      }
      const asOrg = huntTarget ? parsed.values.org === true || !huntTarget.includes('/') : false;
      const target = huntTarget ? (asOrg
        ? { org: orgArg(huntTarget, 'hunt requires owner/repo or an org/user login.') }
        : { repo: repoArg(huntTarget, 'hunt requires owner/repo or an org/user login.') }) : {};
      const rawInput = compact({
        ...target,
        label: filters.label,
        keywords: filters.keywords,
        since: filters.since,
        limit: filters.limit,
        land_hints: filters.land_hints,
        skill_profile: filters.skill_profile,
        max_checks: maxChecks,
        max_repos: maxRepos,
        max_pages: filters.max_pages,
        explain_ranking: filters.explain_ranking,
        skip_policy_gate: parsed.values['skip-policy-gate'] === true ? true : undefined,
        npm_package: stringValue(parsed.values['npm-package']),
        manifest_path: filters.manifest_path
      });
      const effective = await loadEffectiveConfig({ input: rawInput });
      const huntInput = resolveHuntFromConfig(rawInput, effective);
      const abort = new AbortController();
      const onSigInt = () => abort.abort();
      process.once('SIGINT', onSigInt);
      try {
        if (captureRequested(parsed.values)) {
          const mode = captureMode(parsed.values);
          const captureTarget = huntInput.repo
            ? await captureTargetForRepo({ repo: huntInput.repo, capture_mode: mode })
            : captureTargetForOrg(huntInput.org!);
          const captured = await withCaptureSession({
            command: 'hunt',
            capture_mode: mode,
            target: captureTarget,
            source: { surface: 'cli', attribution: 'gitworthy hunt --capture' }
          }, async (session) => {
            const legacy = await hunt({ ...huntInput, capture_persist_checks: true, signal: abort.signal }) as Record<string, unknown>;
            const stamped = toStampedLegacyResult('hunt', legacy) as Record<string, unknown>;
            session.linkRun({ run_id: stringValue(stamped.run_id), decision_ids: extractHuntDecisionIds(stamped) });
            return stamped;
          });
          const manifest = await putCaptureManifest(captured.manifest);
          output = withCaptureOutput(captured.value, manifest);
        } else {
          output = toStampedLegacyResult('hunt', await hunt({ ...huntInput, signal: abort.signal }) as Record<string, unknown>);
        }
      } finally {
        process.removeListener('SIGINT', onSigInt);
      }
    } else if (command === 'scan') {
      commandName = 'scan';
      const repo = repoArg(first, 'scan requires owner/repo.');
      const rawInput = compact({ repo, ...scanFilters(parsed.values) });
      const effective = await loadEffectiveConfig({ input: rawInput });
      output = toStampedLegacyResult('scan', await scan(resolveScanFromConfig(rawInput, effective)) as Record<string, unknown>);
    } else if (command === 'org') {
      commandName = 'org_scan';
      const org = first ? orgArg(first, 'org requires an org or user login.') : undefined;
      const maxRepos = stringValue(parsed.values['max-repos']);
      const rawInput = compact({
        org,
        ...scanFilters(parsed.values),
        max_repos: maxRepos ? Number(maxRepos) : undefined
      });
      const effective = await loadEffectiveConfig({ input: rawInput });
      output = toStampedLegacyResult('org_scan', await org_scan(resolveOrgFromConfig(rawInput, effective)) as Record<string, unknown>);
    } else if (command === 'probes') {
      commandName = 'probes';
      const templates = listProbeTemplates();
      output = toStampedLegacyResult('probes', {
        verdict_summary: `listed ${templates.length} probe templates.`,
        evidence: templates,
        checked: ['listed built-in probe templates'],
        not_checked: ['probe templates are heuristics; they do not prove an issue-specific fix shipped.'],
        signals: [],
        cached: false,
        fetched_at: new Date().toISOString()
      });
    } else if (command === 'ledger') {
      const action = first;
      if (action === 'list') {
        commandName = 'ledger_list';
        const repoFilter = stringValue(parsed.values.repo);
        output = toStampedLegacyResult('ledger_list', await ledger_list({
          repo: repoFilter ? parseArg(RepoRefSchema, repoFilter, 'invalid_repo_ref') : undefined,
          limit: stringValue(parsed.values.limit) ? Number(stringValue(parsed.values.limit)) : undefined
        }) as Record<string, unknown>);
      } else if (action === 'show') {
        commandName = 'ledger_lookup';
        const ref = parseIssueRef(required(second, 'ledger show requires owner/repo#123.'));
        output = toStampedLegacyResult('ledger_lookup', await ledger_lookup(ref) as Record<string, unknown>);
      } else if (action === 'record') {
        commandName = 'ledger_record';
        const ref = parseIssueRef(required(second, 'ledger record requires owner/repo#123.'));
        const verdictRaw = stringValue(parsed.values.verdict);
        const dispositionRaw = stringValue(parsed.values.disposition);
        output = toStampedLegacyResult('ledger_record', await ledger_record({
          ...ref,
          verdict: verdictRaw ? parseArg(VerdictSchema, verdictRaw, 'invalid_usage') : undefined,
          disposition: dispositionRaw ? parseArg(DispositionSchema, dispositionRaw, 'invalid_usage') : undefined,
          notes: stringValue(parsed.values.notes),
          source: 'cli'
        }) as Record<string, unknown>);
      } else if (action === 'migrate') {
        commandName = 'store_migrate_ledger';
        output = toStampedLegacyResult('store_migrate_ledger', await store_migrate_ledger({
          force: parsed.values.force === true
        }) as Record<string, unknown>);
      } else {
        usageError('ledger requires list, show, record, or migrate.');
      }
    } else if (command === 'store') {
      const action = first;
      if (action === 'rebuild-indexes') {
        commandName = 'store_rebuild_indexes';
        output = toStampedLegacyResult('store_rebuild_indexes', await store_rebuild_indexes() as Record<string, unknown>);
      } else if (action === 'target') {
        commandName = 'store_target_show';
        const ref = parseIssueRef(required(second, 'store target requires owner/repo#123.'));
        output = toStampedLegacyResult('store_target_show', await store_target_show(ref) as Record<string, unknown>);
      } else if (action === 'export') {
        commandName = 'store_export';
        const outDir = required(stringValue(parsed.values['out-dir']), 'store export requires --out-dir path.');
        const repoFilter = stringValue(parsed.values.repo);
        const issueRaw = stringValue(parsed.values.issue);
        output = toStampedLegacyResult('store_export', await store_export({
          out_dir: outDir,
          repo: repoFilter ? parseArg(RepoRefSchema, repoFilter, 'invalid_repo_ref') : undefined,
          issue_number: issueRaw ? issueNumberArg(issueRaw, 'store export --issue requires a positive integer.') : undefined
        }) as Record<string, unknown>);
      } else {
        usageError('store requires rebuild-indexes, target, or export.');
      }
    } else if (command === 'run') {
      const action = first;
      if (action === 'show') {
        commandName = 'store_run_show';
        output = toStampedLegacyResult('store_run_show', await store_run_show({
          run_id: required(second, 'run show requires a run_id.')
        }) as Record<string, unknown>);
      } else if (action === 'resume') {
        commandName = 'hunt';
        const runId = required(second, 'run resume requires a run_id.');
        const abort = new AbortController();
        const onSigInt = () => abort.abort();
        process.once('SIGINT', onSigInt);
        try {
          output = toStampedLegacyResult('hunt', await resumeHunt(runId, { signal: abort.signal }) as Record<string, unknown>);
        } finally {
          process.removeListener('SIGINT', onSigInt);
        }
      } else if (action === 'list') {
        commandName = 'store_run_list';
        const repoFilter = stringValue(parsed.values.repo);
        const issueRaw = stringValue(parsed.values.issue);
        output = toStampedLegacyResult('store_run_list', await store_run_list({
          repo: repoFilter ? parseArg(RepoRefSchema, repoFilter, 'invalid_repo_ref') : undefined,
          issue_number: issueRaw ? issueNumberArg(issueRaw, 'run list --issue requires a positive integer.') : undefined,
          limit: stringValue(parsed.values.limit) ? Number(stringValue(parsed.values.limit)) : undefined
        }) as Record<string, unknown>);
      } else {
        usageError('run requires show, resume, or list.');
      }
    } else if (command === 'decision') {
      const action = first;
      if (action === 'show') {
        commandName = 'store_decision_show';
        output = toStampedLegacyResult('store_decision_show', await store_decision_show({
          decision_id: required(second, 'decision show requires a decision_id.')
        }) as Record<string, unknown>);
      } else if (action === 'list') {
        commandName = 'store_decision_list';
        const repoFilter = stringValue(parsed.values.repo);
        const issueRaw = stringValue(parsed.values.issue);
        output = toStampedLegacyResult('store_decision_list', await store_decision_list({
          repo: repoFilter ? parseArg(RepoRefSchema, repoFilter, 'invalid_repo_ref') : undefined,
          issue_number: issueRaw ? issueNumberArg(issueRaw, 'decision list --issue requires a positive integer.') : undefined,
          limit: stringValue(parsed.values.limit) ? Number(stringValue(parsed.values.limit)) : undefined
        }) as Record<string, unknown>);
      } else {
        usageError('decision requires show or list.');
      }
    } else if (command === 'outcome') {
      const action = first;
      if (action === 'show') {
        commandName = 'store_outcome_show';
        output = toStampedLegacyResult('store_outcome_show', await store_outcome_show({
          event_id: required(second, 'outcome show requires an event_id.')
        }) as Record<string, unknown>);
      } else if (action === 'list') {
        commandName = 'store_outcome_list';
        const repoFilter = stringValue(parsed.values.repo);
        const issueRaw = stringValue(parsed.values.issue);
        output = toStampedLegacyResult('store_outcome_list', await store_outcome_list({
          repo: repoFilter ? parseArg(RepoRefSchema, repoFilter, 'invalid_repo_ref') : undefined,
          issue_number: issueRaw ? issueNumberArg(issueRaw, 'outcome list --issue requires a positive integer.') : undefined,
          limit: stringValue(parsed.values.limit) ? Number(stringValue(parsed.values.limit)) : undefined
        }) as Record<string, unknown>);
      } else if (action === 'record') {
        commandName = 'store_outcome_record';
        const ref = parseIssueRef(required(second, 'outcome record requires owner/repo#123.'));
        output = toStampedLegacyResult('store_outcome_record', await store_outcome_record({
          ...ref,
          event: required(stringValue(parsed.values.event), 'outcome record requires --event <name>.'),
          decision_id: stringValue(parsed.values['decision-id']),
          run_id: stringValue(parsed.values['run-id']),
          notes: stringValue(parsed.values.notes),
          close_reason: stringValue(parsed.values['close-reason']),
          acted_against_skip: parsed.values['acted-against-skip'] === true ? true : undefined,
          pr_url: stringValue(parsed.values['pr-url'])
        }) as Record<string, unknown>);
      } else if (action === 'reconcile') {
        commandName = 'store_outcome_reconcile';
        const repoFilter = stringValue(parsed.values.repo);
        const issueRaw = stringValue(parsed.values.issue);
        output = toStampedLegacyResult('store_outcome_reconcile', await store_outcome_reconcile({
          write: parsed.values.write === true,
          dry_run: parsed.values.write === true ? false : true,
          repo: repoFilter ? parseArg(RepoRefSchema, repoFilter, 'invalid_repo_ref') : undefined,
          issue_number: issueRaw ? issueNumberArg(issueRaw, 'outcome reconcile --issue requires a positive integer.') : undefined,
          author: stringValue(parsed.values.author)
        }) as Record<string, unknown>);
      } else if (action === 'backfill') {
        commandName = 'store_outcome_backfill';
        output = toStampedLegacyResult('store_outcome_backfill', await store_outcome_backfill({
          write: parsed.values.write === true,
          dry_run: parsed.values.write === true ? false : true,
          author: stringValue(parsed.values.author)
        }) as Record<string, unknown>);
      } else {
        usageError('outcome requires show, list, record, reconcile, or backfill.');
      }
    } else if (command === 'watch') {
      const action = first;
      if (action === 'add') {
        commandName = 'watch_add';
        const prRaw = stringValue(parsed.values.pr);
        if (prRaw) {
          const repo = repoArg(second, 'watch add --pr requires owner/repo.');
          output = toStampedLegacyResult('watch_add', await watch_add({
            repo,
            pr_number: parseArg(IssueNumberStringSchema, prRaw, 'invalid_usage'),
            note: stringValue(parsed.values.note)
          }) as Record<string, unknown>);
        } else {
          const ref = parseIssueRef(required(second, 'watch add requires owner/repo#123 or owner/repo --pr N.'));
          output = toStampedLegacyResult('watch_add', await watch_add({
            repo: ref.repo,
            issue_number: ref.issue_number,
            note: stringValue(parsed.values.note)
          }) as Record<string, unknown>);
        }
      } else if (action === 'list') {
        commandName = 'watch_list';
        output = toStampedLegacyResult('watch_list', await watch_list() as Record<string, unknown>);
      } else if (action === 'show') {
        commandName = 'watch_show';
        output = toStampedLegacyResult('watch_show', await watch_show(required(second, 'watch show requires a watch_id.')) as Record<string, unknown>);
      } else if (action === 'recheck') {
        commandName = 'watch_recheck';
        output = toStampedLegacyResult('watch_recheck', await watch_recheck({
          watch_id: required(second, 'watch recheck requires a watch_id.'),
          write: parsed.values.write !== false
        }) as Record<string, unknown>);
      } else if (action === 'remove') {
        commandName = 'watch_remove';
        output = toStampedLegacyResult('watch_remove', await watch_remove(required(second, 'watch remove requires a watch_id.')) as Record<string, unknown>);
      } else {
        usageError('watch requires add, list, show, recheck, or remove.');
      }
    } else if (command === 'capture') {
      const action = first;
      if (action === 'show') {
        commandName = 'capture_show';
        output = toStampedLegacyResult('capture_show', await capture_show({
          capture_id: required(second, 'capture show requires a capture_id.')
        }) as Record<string, unknown>);
      } else if (action === 'list') {
        commandName = 'capture_list';
        output = toStampedLegacyResult('capture_list', await capture_list({
          limit: stringValue(parsed.values.limit) ? Number(stringValue(parsed.values.limit)) : undefined
        }) as Record<string, unknown>);
      } else {
        usageError('capture requires show or list.');
      }
    } else if (command === 'case') {
      const action = first;
      if (action !== 'promote') usageError('case requires promote.');
      commandName = 'case_promote';
      const verdictRaw = required(stringValue(parsed.values.verdict), 'case promote requires --verdict ACT|VERIFY|SKIP.');
      const dispositionRaw = required(stringValue(parsed.values.disposition), 'case promote requires --disposition <name>.');
      const evidenceUrls = stringValues(parsed.values['evidence-url']);
      output = toStampedLegacyResult('case_promote', await case_promote({
        capture_id: required(second, 'case promote requires a capture_id.'),
        verdict: parseArg(VerdictSchema, verdictRaw, 'invalid_usage'),
        disposition: parseArg(DispositionSchema, dispositionRaw, 'invalid_usage'),
        adjudicator_rationale: required(stringValue(parsed.values.rationale), 'case promote requires --rationale text.'),
        evidence_urls: evidenceUrls.length > 0 ? evidenceUrls : usageError('case promote requires at least one --evidence-url.'),
        out_path: required(stringValue(parsed.values.out), 'case promote requires --out path.'),
        force: parsed.values.force === true
      }) as Record<string, unknown>);
    } else if (command === 'brief') {
      commandName = 'brief';
      const format = stringValue(parsed.values.format)
        ? parseArg(BriefFormatSchema, stringValue(parsed.values.format), 'invalid_usage')
        : (asJson ? 'json' : 'human');
      const brief = await generateBrief({
        decision_id: required(first, 'brief requires a decision_id.'),
        config_path: stringValue(parsed.values.path)
      });
      const rendered = renderBrief(brief, format);
      const out = stringValue(parsed.values.out);
      if (out) {
        await writeFile(out, rendered, 'utf8');
        stdout(`wrote brief to ${out}\n`);
      } else {
        stdout(rendered);
      }
      return 0;
    } else if (command === 'recheck') {
      commandName = 'store_recheck';
      const ref = parseIssueRef(required(first, 'recheck requires owner/repo#123.'));
      output = toStampedLegacyResult('store_recheck', await store_recheck({
        ...ref,
        npm_package: stringValue(parsed.values['npm-package'])
      }) as Record<string, unknown>);
    } else {
      usageError(`Unknown subcommand ${command}.`);
    }
    print(output, asJson, stdout, { verbose });
    return exitFor(output);
  } catch (error) {
    const structured = toErrorResult({ command: commandName, error });
    if (asJson) {
      stdout(`${JSON.stringify(structured, null, 2)}\n`);
    } else {
      stderr(`${structured.error.message}\n`);
    }
    return structured.error.category === 'input' ? 2 : 1;
  }
}

const invokedPath = process.argv[1];
function invokedUrl(path: string): string {
  try {
    return pathToFileURL(realpathSync(path)).href;
  } catch {
    return pathToFileURL(path).href;
  }
}

if (invokedPath && import.meta.url === invokedUrl(invokedPath)) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
