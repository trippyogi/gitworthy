import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('compiled CLI entry point', () => {
  beforeAll(async () => {
    await execFileAsync('pnpm', ['build']);
  });

  it('runs the built help command through node', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['dist/cli/index.js', '--help']);
    expect(stdout).toContain('gitworthy');
    expect(stdout).toContain('gitworthy mcp');
  });
});
