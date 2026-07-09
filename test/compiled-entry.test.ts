import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('compiled CLI entry point', () => {
  const tempDirs: string[] = [];

  beforeAll(async () => {
    await access('dist/cli/index.js');
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('runs the built help command through node', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['dist/cli/index.js', '--help']);
    expect(stdout).toContain('gitworthy');
    expect(stdout).toContain('gitworthy mcp');
  });

  it('runs the built help command through a symlinked npm-style bin path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gitworthy-bin-'));
    tempDirs.push(tempDir);
    const binPath = join(tempDir, 'gitworthy');
    await symlink(join(process.cwd(), 'dist/cli/index.js'), binPath);

    const { stdout } = await execFileAsync(process.execPath, [binPath, '--help']);

    expect(stdout).toContain('gitworthy');
    expect(stdout).toContain('gitworthy mcp');
  });
});
