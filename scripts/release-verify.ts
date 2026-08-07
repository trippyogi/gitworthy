import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const requireCleanTree = process.env.GITWORTHY_RELEASE_ALLOW_DIRTY !== '1';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const packageJson = readJson<{ version: string; name: string }>(join(root, 'package.json'));
const serverJson = readJson<{ version: string; packages: Array<{ version: string; identifier: string }> }>(join(root, 'server.json'));
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

const failures: string[] = [];

if (packageJson.version !== serverJson.version) {
  failures.push(`package.json version ${packageJson.version} != server.json version ${serverJson.version}`);
}
for (const pkg of serverJson.packages) {
  if (pkg.version !== packageJson.version) {
    failures.push(`server.json package ${pkg.identifier} version ${pkg.version} != ${packageJson.version}`);
  }
}

const versionHeading = new RegExp(`^## ${packageJson.version.replace(/\./g, '\\.')}(?:\\s|$)`, 'm');
if (!versionHeading.test(changelog)) {
  failures.push(`CHANGELOG.md missing heading ## ${packageJson.version}`);
}

if (requireCleanTree) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) {
    failures.push(`working tree is not clean:\n${dirty}`);
  }
}

const requiredFiles = [
  'dist/cli/index.js',
  'dist/mcp/server.js',
  'README.md',
  'LICENSE',
  'SKILL.md',
  'plugin.json',
  'mcp.json',
  'skills/gitworthy/SKILL.md',
  'docs/AGENT_PLUGINS.md'
];
for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`missing required path ${file}`);
}

const pluginJson = readJson<{ version: string; name: string; $schema: string }>(join(root, 'plugin.json'));
if (pluginJson.version !== packageJson.version) {
  failures.push(`plugin.json version ${pluginJson.version} != package.json ${packageJson.version}`);
}
if (pluginJson.name !== 'gitworthy') {
  failures.push(`plugin.json name must be gitworthy`);
}

try {
  execFileSync('pnpm', ['agent-plugins:check'], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
} catch (error) {
  const err = error as { stdout?: string; stderr?: string };
  failures.push(`agent-plugins-check failed:\n${err.stderr ?? err.stdout ?? String(error)}`);
}

if (!existsSync(join(root, 'dist'))) {
  failures.push('dist/ missing; run pnpm build before release:verify');
} else if (readdirSync(join(root, 'dist')).length === 0) {
  failures.push('dist/ is empty');
}

if (failures.length > 0) {
  console.error('release:verify failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`release:verify passed for ${packageJson.name}@${packageJson.version}`);
