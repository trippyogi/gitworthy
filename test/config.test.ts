import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { createMcpServer } from '../src/mcp/server.js';
import { assertSecretFree, loadEffectiveConfig, repoConfigPath, userConfigPath, validateConfigSelection } from '../src/lib/config.js';

let tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, (text) => { stdout += text; }, (text) => { stderr += text; });
  return { code, stdout, stderr };
}

async function callMcpTool(name: string, args: Record<string, unknown>) {
  const server = createMcpServer();
  const client = new Client({ name: 'gitworthy-config-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('config paths', () => {
  it('builds cross-platform user and repo config paths', () => {
    expect(userConfigPath('/home/alice', path.posix)).toBe('/home/alice/.gitworthy/config.json');
    expect(repoConfigPath('/repo/project', path.posix)).toBe('/repo/project/.gitworthy/config.json');
    expect(userConfigPath('C:\\Users\\Alice', path.win32)).toBe('C:\\Users\\Alice\\.gitworthy\\config.json');
    expect(repoConfigPath('C:\\repo\\project', path.win32)).toBe('C:\\repo\\project\\.gitworthy\\config.json');
  });
});

describe('loadEffectiveConfig', () => {
  it('applies precedence input > env > repo > user > defaults with provenance', async () => {
    const dir = await tempDir('gitworthy-config-precedence-');
    const userPath = path.join(dir, 'user.json');
    const repoPath = path.join(dir, 'repo.json');
    await writeJson(userPath, { schema_version: '1.0-draft.1', defaults: { label: 'user-label', limit: 11 }, profile: { languages: ['go'] } });
    await writeJson(repoPath, { schema_version: '1.0-draft.1', defaults: { label: 'repo-label', max_repos: 4 }, profile: { languages: ['typescript'] } });

    const effective = await loadEffectiveConfig({
      userPath,
      repoPath,
      env: { GITWORTHY_LABEL: 'env-label', GITWORTHY_MAX_REPOS: '7', GITWORTHY_SKILL_PROFILE: 'languages=rust' },
      input: { label: 'input-label', limit: 3 }
    });

    expect(effective.values.label).toBe('input-label');
    expect(effective.provenance.label.layer).toBe('input');
    expect(effective.values.limit).toBe(3);
    expect(effective.provenance.limit.layer).toBe('input');
    expect(effective.values.max_repos).toBe(7);
    expect(effective.provenance.max_repos.layer).toBe('env');
    expect(effective.values.skill_profile).toBe('languages=rust');
    expect(effective.provenance.skill_profile.layer).toBe('env');
    expect(effective.values.max_checks).toBe(3);
    expect(effective.provenance.max_checks.layer).toBe('defaults');
  });
});

describe('config validation safety', () => {
  it('rejects secret-like keys and token-like values', () => {
    expect(() => assertSecretFree({ github_token: 'x' }, 'test config')).toThrow(/secret-like key/);
    expect(() => assertSecretFree({ profile: { topics: ['ghp_abcdefghijklmnopqrstuvwxyz123456'] } }, 'test config')).toThrow(/token-like value/);
  });

  it('rejects unsupported schema versions and unknown fields as structured input errors', async () => {
    const dir = await tempDir('gitworthy-config-schema-');
    const badVersion = path.join(dir, 'bad-version.json');
    const unknownField = path.join(dir, 'unknown.json');
    await writeJson(badVersion, { schema_version: '0.0.0', defaults: {} });
    await writeJson(unknownField, { schema_version: '1.0-draft.1', hooks: {} });

    await expect(validateConfigSelection({ path: badVersion })).rejects.toMatchObject({ code: 'config_invalid' });
    await expect(validateConfigSelection({ path: unknownField })).rejects.toMatchObject({ code: 'config_invalid' });
  });
});

describe('target manifest validation', () => {
  it('rejects ambiguous per-repo npm package mappings', async () => {
    const dir = await tempDir('gitworthy-manifest-');
    const manifest = path.join(dir, 'targets.json');
    await writeJson(manifest, {
      schema_version: '1.0-draft.1',
      repos: [{ repo: 'owner/repo', npm_package: 'pkg-a' }],
      package_mappings: [{ repo: 'owner/repo', npm_package: 'pkg-b' }]
    });

    await expect(validateConfigSelection({ manifest_path: manifest })).rejects.toMatchObject({ code: 'manifest_ambiguous_package_mapping' });
  });

  it('accepts repo and org target rules with filters and overrides', async () => {
    const dir = await tempDir('gitworthy-manifest-ok-');
    const manifest = path.join(dir, 'targets.json');
    await writeJson(manifest, {
      schema_version: '1.0-draft.1',
      repos: [{ repo: 'owner/repo', npm_package: 'pkg-a' }],
      orgs: [{ org: 'owner', max_repos: 2 }],
      include: { labels: ['help wanted'], keywords: ['bug'], repos: ['owner/repo'], orgs: ['owner'] },
      exclude: { keywords: ['wontfix'] },
      target_overrides: [{ repo: 'owner/repo', label: 'good first issue' }]
    });

    await expect(validateConfigSelection({ manifest_path: manifest })).resolves.toMatchObject({ ok: true });
  });
});

describe('CLI/MCP config parity', () => {
  it('shows the same effective config values through CLI and MCP', async () => {
    const dir = await tempDir('gitworthy-config-parity-');
    const userPath = path.join(dir, 'config.json');
    await writeJson(userPath, {
      schema_version: '1.0-draft.1',
      defaults: { label: 'help wanted', limit: 9 },
      profile: { languages: ['typescript'], preferred_ecosystems: ['node'] }
    });

    const cli = await run(['config', 'show', '--effective', '--path', userPath, '--json']);
    expect(cli.code).toBe(0);
    const cliPayload = JSON.parse(cli.stdout);
    const mcpPayload = await callMcpTool('config_show', { effective: true, path: userPath });

    expect((cliPayload.values as Record<string, unknown>).label).toBe('help wanted');
    expect(cliPayload.values).toEqual(mcpPayload.values);
    expect(cliPayload.provenance.label.layer).toBe((mcpPayload.provenance as Record<string, Record<string, unknown>>).label.layer);
  });
});
