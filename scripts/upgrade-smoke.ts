/** Upgrade smoke: install last published npm version, then upgrade to packed workspace tarball (GW-037 slice). */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(import.meta.url);
const packageJson = require(join(root, 'package.json')) as { name: string; version: string };
const tempRoot = mkdtempSync(join(tmpdir(), 'gitworthy-upgrade-smoke-'));

function run(cmd: string, cwd = tempRoot): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runNode(args: string[], cwd = tempRoot): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { status?: number; stdout?: string | Buffer };
    return { stdout: String(err.stdout ?? ''), status: typeof err.status === 'number' ? err.status : 1 };
  }
}

try {
  const published = run('npm view gitworthy version', root);
  if (!published) throw new Error('npm view gitworthy version returned empty');
  if (published === packageJson.version) {
    console.log(`upgrade smoke: published ${published} matches workspace; packing and reinstalling same version still validates artifact`);
  } else {
    console.log(`upgrade smoke: ${published} -> packed ${packageJson.version}`);
  }

  writeFileSync(join(tempRoot, 'package.json'), JSON.stringify({ name: 'gitworthy-upgrade-smoke', private: true }, null, 2));
  run(`npm install --omit=dev gitworthy@${published}`);
  const beforeCli = join(tempRoot, 'node_modules', 'gitworthy', 'dist', 'cli', 'index.js');
  if (!existsSync(beforeCli)) throw new Error('published package missing CLI');
  const beforeVersion = runNode([beforeCli, '--version']).stdout.trim();
  if (beforeVersion !== published) throw new Error(`expected published version ${published}, got ${beforeVersion}`);

  const packOut = execSync(`npm pack --pack-destination "${tempRoot}"`, { cwd: root, encoding: 'utf8' }).trim();
  const packLine = packOut.split(/\r?\n/).filter(Boolean).at(-1);
  if (!packLine) throw new Error('npm pack produced no tarball');
  const tarball = existsSync(packLine) ? packLine : join(tempRoot, packLine);

  run(`npm install --omit=dev "${tarball}"`);
  const afterCli = join(tempRoot, 'node_modules', 'gitworthy', 'dist', 'cli', 'index.js');
  const afterVersion = runNode([afterCli, '--version']).stdout.trim();
  if (afterVersion !== packageJson.version) {
    throw new Error(`upgrade did not reach workspace version ${packageJson.version}, got ${afterVersion}`);
  }

  const help = runNode([afterCli, '--help']).stdout;
  if (!help.includes('gitworthy mcp')) throw new Error('upgraded package help missing mcp');

  const doctor = runNode([afterCli, 'doctor', '--json'], tempRoot);
  if (![0, 10, 20].includes(doctor.status)) {
    throw new Error(`doctor unexpected exit ${doctor.status}`);
  }
  const doctorJson = JSON.parse(doctor.stdout) as { capabilities?: unknown[] };
  if (!Array.isArray(doctorJson.capabilities)) throw new Error('upgraded doctor missing capabilities');

  // Rollback: reinstall published version
  run(`npm install --omit=dev gitworthy@${published}`);
  const rolled = runNode([join(tempRoot, 'node_modules', 'gitworthy', 'dist', 'cli', 'index.js'), '--version']).stdout.trim();
  if (rolled !== published) throw new Error(`rollback failed: expected ${published}, got ${rolled}`);

  const installedPkg = JSON.parse(readFileSync(join(tempRoot, 'node_modules', 'gitworthy', 'package.json'), 'utf8')) as { version: string };
  if (installedPkg.version !== published) throw new Error('rollback package.json mismatch');

  console.log(`upgrade smoke passed: ${published} -> ${packageJson.version} -> rollback ${published}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
