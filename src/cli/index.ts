#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
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
import {
  DispositionSchema,
  IssueNumberStringSchema,
  OrgOrUserLoginSchema,
  RepoRefSchema,
  VerdictSchema,
  parseArg,
  parseIssueRef,
  toCheckResult,
  toErrorResult,
  toStampedLegacyResult
} from '../contracts/index.js';
import { persistCheckResultBestEffort } from '../lib/store.js';
import { startMcpServer } from '../mcp/server.js';

const help = `gitworthy

Usage:
  gitworthy --help
  gitworthy --version
  gitworthy doctor [--json]
  gitworthy check owner/repo#123 [--npm-package name] [--probe-glob glob] [--probe-contains text] [--probe-template id] [--json]
  gitworthy hunt owner/repo|org [--max-checks 3] [--label ...] [--keywords ...] [--since 90d] [--limit 25] [--max-repos 8] [--skill-profile ...] [--skip-policy-gate] [--no-land-hints] [--json]
  gitworthy branches owner/repo keyword[,keyword] [--json] [--force-refresh]
  gitworthy issue owner/repo 123 [--json]
  gitworthy release owner/repo package-name [--probe-glob glob] [--probe-contains text] [--probe-template id] [--json]
  gitworthy dupes owner/repo 123 [--json]
  gitworthy related owner/repo [123] [--label ...] [--keywords ...] [--limit 40] [--json]
  gitworthy linked owner/repo 123 [--json]
  gitworthy policy owner/repo [--json]
  gitworthy scan owner/repo [--label "good first issue"] [--keywords term,term] [--since 90d] [--limit 25] [--skill-profile ...] [--no-land-hints] [--json]
  gitworthy org org-or-user [--label ...] [--keywords ...] [--since 90d] [--limit 25] [--max-repos 8] [--skill-profile ...] [--no-land-hints] [--json]
  gitworthy probes [--json]
  gitworthy ledger list [--repo owner/repo] [--limit 50] [--json]
  gitworthy ledger show owner/repo#123 [--json]
  gitworthy ledger record owner/repo#123 [--verdict ACT] [--disposition greenfield] [--notes text] [--json]
  gitworthy mcp
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

function print(output: unknown, asJson: boolean, write: Write): void {
  if (asJson) write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    const value = output as { verdict_summary?: string; verdict?: string };
    const summary = value.verdict_summary ?? JSON.stringify(output);
    const prefix = value.verdict && !summary.startsWith(`${value.verdict}:`) ? `${value.verdict}: ` : '';
    write(`${prefix}${summary}\n`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
  return {
    label: stringValue(values.label),
    keywords: stringValue(values.keywords)?.split(',').filter(Boolean),
    since: stringValue(values.since),
    limit: stringValue(values.limit) ? Number(stringValue(values.limit)) : undefined,
    land_hints: values['no-land-hints'] === true ? false : undefined,
    skill_profile: stringValue(values['skill-profile'])
  };
}

const CLI_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  json: { type: 'boolean' },
  'npm-package': { type: 'string' },
  'probe-glob': { type: 'string' },
  'probe-contains': { type: 'string' },
  'probe-template': { type: 'string' },
  'skill-profile': { type: 'string' },
  'skip-policy-gate': { type: 'boolean' },
  'force-refresh': { type: 'boolean' },
  label: { type: 'string' },
  keywords: { type: 'string' },
  since: { type: 'string' },
  limit: { type: 'string' },
  'max-repos': { type: 'string' },
  'max-checks': { type: 'string' },
  'no-land-hints': { type: 'boolean' },
  repo: { type: 'string' },
  org: { type: 'boolean' },
  verdict: { type: 'string' },
  disposition: { type: 'string' },
  notes: { type: 'string' }
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
  if (argv[0] === 'branches' && argv[2]?.startsWith('-')) {
    try {
      const repo = repoArg(argv[1], 'branches requires owner/repo and keywords.');
      const second = required(argv[2], 'branches requires owner/repo and keywords.');
      stderr(`Warning: branch keyword "${second}" starts with a dash. Use -- before positional arguments if your shell or parser treats it as an option.\n`);
      const output = toStampedLegacyResult('branch_scan', await branch_scan({
        repo,
        keywords: second.split(',').filter(Boolean),
        force_refresh: argv.includes('--force-refresh')
      }) as Record<string, unknown>);
      print(output, asJsonEarly, stdout);
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
    await startMcpServer();
    return 0;
  }
  const asJson = parsed.values.json === true;
  let commandName = command ?? 'unknown';
  try {
    let output: unknown;
    if (command === 'doctor') {
      commandName = 'doctor';
      output = toStampedLegacyResult('doctor', await doctor() as Record<string, unknown>);
    } else if (command === 'check') {
      commandName = 'check';
      const ref = parseIssueRef(required(first, 'check requires owner/repo#123.'));
      const legacy = await worth_check({
        ...ref,
        npm_package: stringValue(parsed.values['npm-package']),
        probe: probe(parsed.values),
        probe_template: stringValue(parsed.values['probe-template'])
      });
      const check = toCheckResult(legacy as Record<string, unknown>, ref);
      await persistCheckResultBestEffort(check);
      output = check;
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
    } else if (command === 'policy') {
      commandName = 'contrib_policy';
      const repo = repoArg(first, 'policy requires owner/repo.');
      output = toStampedLegacyResult('contrib_policy', await contrib_policy({ repo, force_refresh: parsed.values['force-refresh'] === true }) as Record<string, unknown>);
    } else if (command === 'hunt') {
      commandName = 'hunt';
      const huntTarget = required(first, 'hunt requires owner/repo or an org/user login.');
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
      if (parsed.values.org === true && huntTarget.includes('/')) {
        usageError('hunt --org expects an org or user login, not owner/repo. Omit --org for a single repo.');
      }
      const asOrg = parsed.values.org === true || !huntTarget.includes('/');
      const target = asOrg
        ? { org: orgArg(huntTarget, 'hunt requires owner/repo or an org/user login.') }
        : { repo: repoArg(huntTarget, 'hunt requires owner/repo or an org/user login.') };
      output = toStampedLegacyResult('hunt', await hunt({
        ...target,
        label: filters.label,
        keywords: filters.keywords,
        since: filters.since,
        scan_limit: filters.limit,
        land_hints: filters.land_hints,
        skill_profile: filters.skill_profile,
        max_checks: maxChecks,
        max_repos: maxRepos,
        skip_policy_gate: parsed.values['skip-policy-gate'] === true,
        npm_package: stringValue(parsed.values['npm-package'])
      }) as Record<string, unknown>);
    } else if (command === 'scan') {
      commandName = 'scan';
      const repo = repoArg(first, 'scan requires owner/repo.');
      output = toStampedLegacyResult('scan', await scan({ repo, ...scanFilters(parsed.values) }) as Record<string, unknown>);
    } else if (command === 'org') {
      commandName = 'org_scan';
      const org = orgArg(first, 'org requires an org or user login.');
      const maxRepos = stringValue(parsed.values['max-repos']);
      output = toStampedLegacyResult('org_scan', await org_scan({
        org,
        ...scanFilters(parsed.values),
        max_repos: maxRepos ? Number(maxRepos) : undefined
      }) as Record<string, unknown>);
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
      } else {
        usageError('ledger requires list, show, or record.');
      }
    } else {
      usageError(`Unknown subcommand ${command}.`);
    }
    print(output, asJson, stdout);
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
