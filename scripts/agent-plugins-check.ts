/**
 * Validate Agent Plugins v1 packaging and keep root SKILL.md synced to the canonical skill.
 *
 * Usage:
 *   pnpm exec tsx scripts/agent-plugins-check.ts           # verify
 *   pnpm exec tsx scripts/agent-plugins-check.ts --write   # rewrite root SKILL.md from skills/
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const write = process.argv.includes('--write');
const failures: string[] = [];

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseSkill(rel: string): { frontmatter: Record<string, string>; body: string } {
  const raw = stripBom(readFileSync(path.join(root, rel), 'utf8')).replace(/\r\n/g, '\n');
  if (!raw.startsWith('---\n')) {
    return { frontmatter: {}, body: raw.trimEnd() + '\n' };
  }
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) {
    failures.push(`${rel}: missing closing frontmatter delimiter`);
    return { frontmatter: {}, body: raw.trimEnd() + '\n' };
  }
  const yaml = raw.slice(4, end);
  const body = raw.slice(end + 5).replace(/^\n/, '');
  const frontmatter: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    if (!line.trim() || line.startsWith(' ') || line.startsWith('\t')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) frontmatter[m[1]!] = m[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return { frontmatter, body: body.trimEnd() + '\n' };
}

const packageJson = readJson('package.json') as { version: string; files?: string[] };
const pluginJson = readJson('plugin.json') as {
  $schema?: string;
  name?: string;
  version?: string;
};
const mcpJson = readJson('mcp.json') as {
  $schema?: string;
  mcpServers?: Record<string, { type?: string; command?: string; args?: string[] }>;
};

if (pluginJson.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') {
  failures.push('plugin.json $schema must target Agent Plugins 1.0.0');
}
if (pluginJson.name !== 'gitworthy') failures.push(`plugin.json name must be gitworthy (got ${pluginJson.name})`);
if (pluginJson.version !== packageJson.version) {
  failures.push(`plugin.json version ${pluginJson.version} != package.json ${packageJson.version}`);
}

if (mcpJson.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') {
  failures.push('mcp.json $schema must target Agent Plugins 1.0.0');
}
const server = mcpJson.mcpServers?.gitworthy;
if (!server || server.type !== 'stdio') failures.push('mcp.json must define stdio server "gitworthy"');
if (server?.command !== 'node') failures.push('mcp.json gitworthy.command must be node');
const args = server?.args ?? [];
if (!args.some((a) => a.includes('${PLUGIN_ROOT}') && a.includes('dist/cli/index.js'))) {
  failures.push('mcp.json args must launch ${PLUGIN_ROOT}/dist/cli/index.js');
}
if (!args.includes('mcp')) failures.push('mcp.json args must include mcp');

const skillRel = 'skills/gitworthy/SKILL.md';
if (!existsSync(path.join(root, skillRel))) {
  failures.push(`missing ${skillRel}`);
} else {
  const skill = parseSkill(skillRel);
  if (skill.frontmatter.name !== 'gitworthy') {
    failures.push(`${skillRel} frontmatter name must be gitworthy`);
  }
  if (!skill.frontmatter.description || skill.frontmatter.description.length < 20) {
    failures.push(`${skillRel} frontmatter description is required`);
  }
  const rootSkillPath = path.join(root, 'SKILL.md');
  const expectedRoot = skill.body;
  if (write) {
    writeFileSync(rootSkillPath, expectedRoot, 'utf8');
  } else {
    const rootBody = stripBom(readFileSync(rootSkillPath, 'utf8')).replace(/\r\n/g, '\n').trimEnd() + '\n';
    if (rootBody !== expectedRoot) {
      failures.push('SKILL.md is out of sync with skills/gitworthy/SKILL.md (run: pnpm agent-plugins:check -- --write)');
    }
  }
}

const files = packageJson.files ?? [];
for (const entry of ['plugin.json', 'mcp.json', 'skills', 'SKILL.md']) {
  if (!files.includes(entry) && !files.includes(`${entry}/`)) {
    failures.push(`package.json files must include "${entry}"`);
  }
}

if (!existsSync(path.join(root, 'docs/AGENT_PLUGINS.md'))) {
  failures.push('missing docs/AGENT_PLUGINS.md');
}

if (failures.length > 0) {
  console.error('agent-plugins-check failed:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log(
  write
    ? `agent-plugins-check: wrote SKILL.md from ${skillRel}`
    : `agent-plugins-check passed (Agent Plugins 1.0.0, v${packageJson.version})`
);