import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';

const execFileAsync = promisify(execFile);
const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

describe('CLI version', () => {
  it('prints package version for --version, -V, and version', async () => {
    for (const argv of [['--version'], ['-V'], ['version']]) {
      let out = '';
      const code = await runCli(argv, (text) => {
        out += text;
      });
      expect(code).toBe(0);
      expect(out.trim()).toBe(packageVersion);
    }
  });

  it('prints version from the compiled entry', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['dist/cli/index.js', '--version']);
    expect(stdout.trim()).toBe(packageVersion);
  }, 15_000);
});
