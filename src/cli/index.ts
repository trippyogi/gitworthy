#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { branch_scan, contrib_policy, dupe_cluster, issue_vs_main, ledger_add, ledger_claim, ledger_list, ledger_update, linked_work, release_gap, scan, worth_check, type LedgerStatus, type LedgerVerdict } from '../core/index.js';
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
  gitworthy ledger add owner/repo#123 [--verdict ACT] [--status candidate] [--json]
  gitworthy ledger list [--status claimed] [--repo owner/repo] [--json]
  gitworthy ledger claim owner/repo#123 [--chat-id id] [--json]
  gitworthy ledger update owner/repo#123 --status patched [--notes text] [--json]
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

const LEDGER_STATUSES = new Set<LedgerStatus>(['candidate', 'claimed', 'reproved', 'patched', 'pr_or_comment', 'done', 'abandoned']);
const LEDGER_VERDICTS = new Set<LedgerVerdict>(['ACT', 'VERIFY', 'SKIP']);

function ledgerStatus(value: unknown): LedgerStatus | undefined {
  const status = stringValue(value);
  if (!status) return undefined;
  if (!LEDGER_STATUSES.has(status as LedgerStatus)) throw new Error(`Unknown ledger status ${status}.`);
  return status as LedgerStatus;
}

function ledgerVerdict(value: unknown): LedgerVerdict | undefined {
  const verdict = stringValue(value);
  if (!verdict) return undefined;
  if (!LEDGER_VERDICTS.has(verdict as LedgerVerdict)) throw new Error(`Unknown verdict ${verdict}.`);
  return verdict as LedgerVerdict;
}

function printLedger(output: unknown, asJson: boolean, write: Write): void {
  if (asJson) {
    write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (Array.isArray((output as { records?: unknown[] }).records)) {
    const records = (output as { records: Array<{ repo: string; issue_number: number; status: string; url: string }> }).records;
    if (records.length === 0) {
      write('No ledger records.\n');
      return;
    }
    for (const record of records) write(`${record.repo}#${record.issue_number} ${record.status} ${record.url}\n`);
    return;
  }
  const record = output as { repo: string; issue_number: number; status: string; url: string };
  write(`${record.repo}#${record.issue_number} ${record.status} ${record.url}\n`);
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
  const parsed = parseArgs({ args: argv, allowPositionals: true, strict: false, options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, 'npm-package': { type: 'string' }, 'probe-glob': { type: 'string' }, 'probe-contains': { type: 'string' }, 'force-refresh': { type: 'boolean' }, label: { type: 'string' }, keywords: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' }, verdict: { type: 'string' }, status: { type: 'string' }, repo: { type: 'string' }, 'chat-id': { type: 'string' }, notes: { type: 'string' } } });
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
    } else if (command === 'ledger') {
      const ledgerCommand = first;
      if (ledgerCommand === 'add') {
        if (!second) throw new Error('ledger add requires owner/repo#123.');
        output = await ledger_add({ ...parseIssueRef(second), verdict: ledgerVerdict(parsed.values.verdict), status: ledgerStatus(parsed.values.status) });
      } else if (ledgerCommand === 'list') {
        output = await ledger_list({ status: ledgerStatus(parsed.values.status), repo: stringValue(parsed.values.repo) });
      } else if (ledgerCommand === 'claim') {
        if (!second) throw new Error('ledger claim requires owner/repo#123.');
        output = await ledger_claim({ ...parseIssueRef(second), chat_id: stringValue(parsed.values['chat-id']) });
      } else if (ledgerCommand === 'update') {
        if (!second) throw new Error('ledger update requires owner/repo#123.');
        const status = ledgerStatus(parsed.values.status);
        if (!status) throw new Error('ledger update requires --status.');
        output = await ledger_update({ ...parseIssueRef(second), status, notes: stringValue(parsed.values.notes) });
      } else {
        throw new Error(`Unknown ledger subcommand ${ledgerCommand ?? '(missing)'}.`);
      }
    } else {
      throw new Error(`Unknown subcommand ${command}.`);
    }
    if (command === 'ledger') {
      printLedger(output, asJson, stdout);
      return 0;
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
