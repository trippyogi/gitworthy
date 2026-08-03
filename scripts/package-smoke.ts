import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(import.meta.url);
const packageJson = require(join(root, 'package.json')) as { name: string; version: string };
const tempRoot = mkdtempSync(join(tmpdir(), 'gitworthy-package-smoke-'));

function runNode(
  args: string[],
  cwd = root,
  allowFail = false,
  env?: NodeJS.ProcessEnv
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
      timeout: 60_000
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const err = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    if (!allowFail) throw error;
    return {
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
      status: typeof err.status === 'number' ? err.status : 1
    };
  }
}

try {
  console.log('packing…');
  const packOut = execSync(`npm pack --pack-destination "${tempRoot}"`, { cwd: root, encoding: 'utf8' }).trim();
  const packLine = packOut.split(/\r?\n/).filter(Boolean).at(-1);
  if (!packLine) throw new Error('npm pack produced no tarball path');
  const tarball = existsSync(packLine) ? packLine : join(tempRoot, packLine);

  writeFileSync(join(tempRoot, 'package.json'), JSON.stringify({ name: 'gitworthy-smoke-consumer', private: true }, null, 2));
  execSync(`npm install --omit=dev "${tarball}"`, { cwd: tempRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const cliJs = join(tempRoot, 'node_modules', 'gitworthy', 'dist', 'cli', 'index.js');
  if (!existsSync(cliJs)) throw new Error(`packed package missing ${cliJs}`);

  const version = runNode([cliJs, '--version'], tempRoot).stdout.trim();
  if (version !== packageJson.version) {
    throw new Error(`expected --version ${packageJson.version}, got ${version}`);
  }

  const help = runNode([cliJs, '--help'], tempRoot).stdout;
  if (!help.includes('gitworthy mcp')) throw new Error('packed --help missing mcp usage');
  if (!help.includes('--version')) throw new Error('packed --help missing --version');

  const invalid = runNode([cliJs, 'check', 'not-an-issue-ref', '--json'], tempRoot, true);
  if (invalid.status === 0) throw new Error('invalid issue ref should fail');
  const invalidText = `${invalid.stderr}${invalid.stdout}`.toLowerCase();
  if (!invalidText.includes('expected issue ref')) {
    throw new Error(`invalid issue ref output unexpected: ${invalid.stderr}${invalid.stdout}`);
  }

  // doctor may exit VERIFY(10)/SKIP(20) when the environment is not ready (e.g. no token).
  // Smoke only requires a structured JSON diagnostic, not an ACT/pass exit.
  const doctorEnv = {
    ...process.env,
    GITWORTHY_CACHE_DIR: join(tempRoot, 'cache'),
    GITHUB_TOKEN: '',
    GH_TOKEN: ''
  };
  const doctor = runNode([cliJs, 'doctor', '--json'], tempRoot, true, doctorEnv);
  if (![0, 10, 20].includes(doctor.status)) {
    throw new Error(`doctor --json unexpected exit ${doctor.status}: ${doctor.stderr}${doctor.stdout}`);
  }
  const doctorJson = JSON.parse(doctor.stdout) as {
    checked?: unknown[];
    not_checked?: unknown[];
    capabilities?: unknown[];
    verdict?: string;
  };
  if (!Array.isArray(doctorJson.checked) || !Array.isArray(doctorJson.not_checked)) {
    throw new Error('doctor --json missing checked/not_checked arrays');
  }
  if (!Array.isArray(doctorJson.capabilities) || doctorJson.capabilities.length === 0) {
    throw new Error('doctor --json missing capabilities matrix');
  }
  if (typeof doctorJson.verdict !== 'string') {
    throw new Error('doctor --json missing verdict');
  }

  const installedPkg = JSON.parse(readFileSync(join(tempRoot, 'node_modules', 'gitworthy', 'package.json'), 'utf8')) as { version: string };
  if (installedPkg.version !== packageJson.version) {
    throw new Error(`installed package version mismatch ${installedPkg.version}`);
  }

  console.log(`package smoke passed for ${packageJson.name}@${packageJson.version}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
