#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { branch_scan, contrib_policy, dupe_cluster, issue_vs_main, linked_work, release_gap, scan, worth_check } from '../core/index.js';
import { startMcpServer } from '../mcp/server.js';

const help = `gitworthy

Usage:
  gitworthy --help
  gitworthy check owner/repo#123 [--npm-package name] [--probe-glob glob] [--probe-contains text] [--json]
  gitworthy branches owner/repo keyword[,keyword] [--json] [--force-refresh]
  gitworthy issue owner/repo 123 [--json]
  gitworthy release owner/repo package-name [--probe-glob glob] [--probe-contains text] [--json]
  gitworthy dupes owner/repo 123 [--json]
  gitworthy linked owner/repo 123 [--json]
  gitworthy policy owner/repo [--json]
  gitworthy scan owner/repo [--label "good first issue"] [--keywords term,term] [--since 90d] [--limit 25] [--json]
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
  const parsed = parseArgs({ args: argv, allowPositionals: true, strict: false, options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, 'npm-package': { type: 'string' }, 'probe-glob': { type: 'string' }, 'probe-contains': { type: 'string' }, 'force-refresh': { type: 'boolean' }, label: { type: 'string' }, keywords: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' } } });
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
    if (command === 'check') {
      if (!first) throw new Error('check requires owner/repo#123.');
      output = await worth_check({ ...parseIssueRef(first), npm_package: stringValue(parsed.values['npm-package']), probe: probe(parsed.values) });
    } else if (command === 'branches') {
      if (!first || !second) throw new Error('branches requires owner/repo and keywords.');
      for (const keyword of second.split(',').filter(Boolean)) if (keyword.startsWith('-')) stderr(`Warning: branch keyword "${keyword}" starts with a dash. Use -- before positional arguments if your shell or parser treats it as an option.\n`);
      output = await branch_scan({ repo: first, keywords: second.split(',').filter(Boolean), force_refresh: parsed.values['force-refresh'] === true });
    } else if (command === 'issue') {
      if (!first || !second) throw new Error('issue requires owner/repo and issue number.');
      output = await issue_vs_main({ repo: first, issue_number: Number(second) });
    } else if (command === 'release') {
      if (!first || !second) throw new Error('release requires owner/repo and package name.');
      output = await release_gap({ repo: first, npm_package: second, probe: probe(parsed.values), force_refresh: parsed.values['force-refresh'] === true });
    } else if (command === 'dupes') {
      if (!first || !second) throw new Error('dupes requires owner/repo and issue number.');
      output = await dupe_cluster({ repo: first, issue_number: Number(second) });
    } else if (command === 'linked') {
      if (!first || !second) throw new Error('linked requires owner/repo and issue number.');
      output = await linked_work({ repo: first, issue_number: Number(second) });
    } else if (command === 'policy') {
      if (!first) throw new Error('policy requires owner/repo.');
      output = await contrib_policy({ repo: first, force_refresh: parsed.values['force-refresh'] === true });
    } else if (command === 'scan') {
      if (!first) throw new Error('scan requires owner/repo.');
      output = await scan({ repo: first, label: stringValue(parsed.values.label), keywords: stringValue(parsed.values.keywords)?.split(',').filter(Boolean), since: stringValue(parsed.values.since), limit: stringValue(parsed.values.limit) ? Number(stringValue(parsed.values.limit)) : undefined });
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
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
