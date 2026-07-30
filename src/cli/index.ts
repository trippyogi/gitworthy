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
import { startMcpServer } from '../mcp/server.js';

const help = `gitworthy

Usage:
  gitworthy --help
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

function parseIssueRef(ref: string): { repo: string; issue_number: number } {
  const match = ref.match(/^([^#]+)#(\d+)$/);
  if (!match) throw new Error('Expected issue ref like owner/repo#123.');
  return { repo: match[1], issue_number: Number(match[2]) };
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

export async function runCli(argv = process.argv.slice(2), stdout: Write = (text) => process.stdout.write(text), stderr: Write = (text) => process.stderr.write(text)): Promise<number> {
  if (argv[0] === 'branches' && argv[2]?.startsWith('-')) {
    const first = argv[1];
    const second = argv[2];
    if (!first || !second) {
      stderr('branches requires owner/repo and keywords.\n');
      return 1;
    }
    stderr(`Warning: branch keyword "${second}" starts with a dash. Use -- before positional arguments if your shell or parser treats it as an option.\n`);
    const output = await branch_scan({ repo: first, keywords: second.split(',').filter(Boolean), force_refresh: argv.includes('--force-refresh') });
    print(output, argv.includes('--json'), stdout);
    return 0;
  }
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: 'boolean', short: 'h' },
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
    }
  });
  const [command, first, second] = parsed.positionals;
  if (parsed.values.help || !command) {
    stdout(help);
    return 0;
  }
  if (command === 'mcp') {
    await startMcpServer();
    return 0;
  }
  const asJson = parsed.values.json === true;
  try {
    let output: unknown;
    if (command === 'doctor') {
      output = await doctor();
    } else if (command === 'check') {
      if (!first) throw new Error('check requires owner/repo#123.');
      output = await worth_check({
        ...parseIssueRef(first),
        npm_package: stringValue(parsed.values['npm-package']),
        probe: probe(parsed.values),
        probe_template: stringValue(parsed.values['probe-template'])
      });
    } else if (command === 'branches') {
      if (!first || !second) throw new Error('branches requires owner/repo and keywords.');
      for (const keyword of second.split(',').filter(Boolean)) if (keyword.startsWith('-')) stderr(`Warning: branch keyword "${keyword}" starts with a dash. Use -- before positional arguments if your shell or parser treats it as an option.\n`);
      output = await branch_scan({ repo: first, keywords: second.split(',').filter(Boolean), force_refresh: parsed.values['force-refresh'] === true });
    } else if (command === 'issue') {
      if (!first || !second) throw new Error('issue requires owner/repo and issue number.');
      output = await issue_vs_main({ repo: first, issue_number: Number(second) });
    } else if (command === 'release') {
      if (!first || !second) throw new Error('release requires owner/repo and package name.');
      output = await release_gap({
        repo: first,
        npm_package: second,
        probe: probe(parsed.values),
        probe_template: stringValue(parsed.values['probe-template']),
        force_refresh: parsed.values['force-refresh'] === true
      });
    } else if (command === 'dupes') {
      if (!first || !second) throw new Error('dupes requires owner/repo and issue number.');
      output = await dupe_cluster({ repo: first, issue_number: Number(second) });
    } else if (command === 'related') {
      if (!first) throw new Error('related requires owner/repo.');
      const filters = scanFilters(parsed.values);
      output = await related_cluster({
        repo: first,
        issue_number: second ? Number(second) : undefined,
        label: filters.label,
        keywords: filters.keywords,
        limit: filters.limit
      });
    } else if (command === 'linked') {
      if (!first || !second) throw new Error('linked requires owner/repo and issue number.');
      output = await linked_work({ repo: first, issue_number: Number(second) });
    } else if (command === 'policy') {
      if (!first) throw new Error('policy requires owner/repo.');
      output = await contrib_policy({ repo: first, force_refresh: parsed.values['force-refresh'] === true });
    } else if (command === 'hunt') {
      if (!first) throw new Error('hunt requires owner/repo or an org/user login.');
      const maxChecksRaw = stringValue(parsed.values['max-checks']);
      const maxChecks = maxChecksRaw ? Number(maxChecksRaw) : undefined;
      if (maxChecksRaw && (!Number.isFinite(maxChecks) || (maxChecks as number) < 1)) {
        throw new Error('--max-checks must be a positive number.');
      }
      const maxReposRaw = stringValue(parsed.values['max-repos']);
      const maxRepos = maxReposRaw ? Number(maxReposRaw) : undefined;
      if (maxReposRaw && (!Number.isFinite(maxRepos) || (maxRepos as number) < 1)) {
        throw new Error('--max-repos must be a positive number.');
      }
      const filters = scanFilters(parsed.values);
      // --org forces org mode; otherwise slash ⇒ repo, no slash ⇒ org/user.
      const asOrg = parsed.values.org === true || !first.includes('/');
      if (parsed.values.org === true && first.includes('/')) {
        throw new Error('hunt --org expects an org or user login, not owner/repo. Omit --org for a single repo.');
      }
      output = await hunt({
        ...(asOrg ? { org: first } : { repo: first }),
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
      });
    } else if (command === 'scan') {
      if (!first) throw new Error('scan requires owner/repo.');
      output = await scan({ repo: first, ...scanFilters(parsed.values) });
    } else if (command === 'org') {
      if (!first) throw new Error('org requires an org or user login.');
      const maxRepos = stringValue(parsed.values['max-repos']);
      output = await org_scan({
        org: first,
        ...scanFilters(parsed.values),
        max_repos: maxRepos ? Number(maxRepos) : undefined
      });
    } else if (command === 'probes') {
      const templates = listProbeTemplates();
      output = {
        verdict_summary: `listed ${templates.length} probe templates.`,
        evidence: templates,
        checked: ['listed built-in probe templates'],
        not_checked: ['probe templates are heuristics; they do not prove an issue-specific fix shipped.'],
        signals: [],
        cached: false,
        fetched_at: new Date().toISOString()
      };
    } else if (command === 'ledger') {
      const action = first;
      if (action === 'list') {
        output = await ledger_list({
          repo: stringValue(parsed.values.repo),
          limit: stringValue(parsed.values.limit) ? Number(stringValue(parsed.values.limit)) : undefined
        });
      } else if (action === 'show') {
        if (!second) throw new Error('ledger show requires owner/repo#123.');
        output = await ledger_lookup(parseIssueRef(second));
      } else if (action === 'record') {
        if (!second) throw new Error('ledger record requires owner/repo#123.');
        output = await ledger_record({
          ...parseIssueRef(second),
          verdict: stringValue(parsed.values.verdict),
          disposition: stringValue(parsed.values.disposition),
          notes: stringValue(parsed.values.notes),
          source: 'cli'
        });
      } else {
        throw new Error('ledger requires list, show, or record.');
      }
    } else {
      throw new Error(`Unknown subcommand ${command}.`);
    }
    print(output, asJson, stdout);
    return exitFor(output);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
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
