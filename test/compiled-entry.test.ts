import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('compiled CLI entry point', () => {
  beforeAll(async () => {
    await access('dist/cli/index.js');
  });

  it('runs the built help command through node', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['dist/cli/index.js', '--help']);
    expect(stdout).toContain('gitworthy');
    expect(stdout).toContain('gitworthy mcp');
  });
});
