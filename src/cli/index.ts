#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { branch_scan, contrib_policy, dupe_cluster, issue_vs_main, release_gap, worth_check } from '../core/index.js';
import { startMcpServer } from '../mcp/server.js';

const help = `gitworthy

Usage:
  gitworthy --help
  gitworthy check owner/repo#123 [--npm-package name] [--json]
  gitworthy branches owner/repo keyword[,keyword] [--json] [--force-refresh]
  gitworthy issue owner/repo 123 [--json]
  gitworthy release owner/repo package-name [--json]
  gitworthy dupes owner/repo 123 [--json]
  gitworthy policy owner/repo [--json]
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
    write(`${value.verdict ? `${value.verdict}: ` : ''}${value.verdict_summary ?? JSON.stringify(output)}\n`);
  }
}

function exitFor(output: unknown): number {
  const value = output as { verdict?: string };
  if (value.verdict === 'ACT') return 0;
  if (value.verdict === 'VERIFY') return 10;
  if (value.verdict === 'SKIP') return 20;
  return 0;
}

export async function runCli(argv = process.argv.slice(2), stdout: Write = (text) => process.stdout.write(text), stderr: Write = (text) => process.stderr.write(text)): Promise<number> {
  const parsed = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, 'npm-package': { type: 'string' }, 'force-refresh': { type: 'boolean' } } });
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
      output = await worth_check({ ...parseIssueRef(first), npm_package: parsed.values['npm-package'] });
    } else if (command === 'branches') {
      if (!first || !second) throw new Error('branches requires owner/repo and keywords.');
      output = await branch_scan({ repo: first, keywords: second.split(',').filter(Boolean), force_refresh: parsed.values['force-refresh'] === true });
    } else if (command === 'issue') {
      if (!first || !second) throw new Error('issue requires owner/repo and issue number.');
      output = await issue_vs_main({ repo: first, issue_number: Number(second) });
    } else if (command === 'release') {
      if (!first || !second) throw new Error('release requires owner/repo and package name.');
      output = await release_gap({ repo: first, npm_package: second, force_refresh: parsed.values['force-refresh'] === true });
    } else if (command === 'dupes') {
      if (!first || !second) throw new Error('dupes requires owner/repo and issue number.');
      output = await dupe_cluster({ repo: first, issue_number: Number(second) });
    } else if (command === 'policy') {
      if (!first) throw new Error('policy requires owner/repo.');
      output = await contrib_policy({ repo: first, force_refresh: parsed.values['force-refresh'] === true });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
