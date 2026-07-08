#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startMcpServer } from '../mcp/server.js';

const help = `gitworthy

Usage:
  gitworthy --help
  gitworthy check owner/repo#123 [--json]
  gitworthy branches owner/repo keyword[,keyword] [--json]
  gitworthy issue owner/repo 123 [--json]
  gitworthy release owner/repo package-name [--json]
  gitworthy dupes owner/repo 123 [--json]
  gitworthy policy owner/repo [--json]
  gitworthy mcp
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } } });
  const [command] = parsed.positionals;
  if (parsed.values.help || !command) {
    process.stdout.write(help);
    return;
  }
  if (command === 'mcp') {
    await startMcpServer();
    return;
  }
  process.stderr.write(`Subcommand ${command} is not implemented until its core phase is complete.\n`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
