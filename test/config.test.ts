import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { createMcpServer } from '../src/mcp/server.js';
import {
  assertSecretFree,
  loadEffectiveConfig,
  profileForShow,
  repoConfigPath,
  resolveHuntFromConfig,
  resolveScanFromConfig,
  userConfigPath,
  validateConfigSelection
} from '../src/lib/config.js';

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

  it('loads an optional contribution_profile without requiring Hermes domains', async () => {
    const dir = await tempDir('gitworthy-config-contrib-profile-');
    const repoPath = path.join(dir, 'repo.json');
    await writeJson(repoPath, {
      schema_version: '1.0-draft.1',
      contribution_profile: {
        stale_pr_days: 21,
        platforms: ['windows'],
        mode_weights: { REVIEW: 1.2 }
      }
    });
    const effective = await loadEffectiveConfig({ repoPath, env: {} });
    expect(effective.values.contribution_profile?.stale_pr_days).toBe(21);
    expect(effective.values.contribution_profile?.platforms).toEqual(['windows']);
    expect(effective.values.contribution_profile?.mode_weights.REVIEW).toBe(1.2);
    expect(effective.values.contribution_profile?.domains).toEqual([]);
  });

  it('lets target manifest overrides beat built-in defaults', async () => {
    const dir = await tempDir('gitworthy-config-manifest-override-');
    const manifestPath = path.join(dir, 'targets.json');
    await writeJson(manifestPath, {
      schema_version: '1.0-draft.1',
      repos: [{ repo: 'owner/repo', limit: 2, land_hints: false }]
    });

    const effective = await loadEffectiveConfig({
      userPath: path.join(dir, 'missing-user.json'),
      repoPath: path.join(dir, 'missing-repo.json'),
      env: {},
      input: { repo: 'owner/repo', manifest_path: manifestPath }
    });
    const scanInput = resolveScanFromConfig({ repo: 'owner/repo' }, effective);

    expect(effective.values.limit).toBe(2);
    expect(effective.values.land_hints).toBe(false);
    expect(effective.provenance.limit.layer).toBe('manifest');
    expect(scanInput.limit).toBe(2);
    expect(scanInput.land_hints).toBe(false);
  });

  it('keeps env and explicit input above target manifest overrides', async () => {
    const dir = await tempDir('gitworthy-config-manifest-order-');
    const manifestPath = path.join(dir, 'targets.json');
    await writeJson(manifestPath, {
      schema_version: '1.0-draft.1',
      repos: [{ repo: 'owner/repo', limit: 2, land_hints: false }]
    });

    const envEffective = await loadEffectiveConfig({
      userPath: path.join(dir, 'missing-user.json'),
      repoPath: path.join(dir, 'missing-repo.json'),
      env: { GITWORTHY_LIMIT: '9', GITWORTHY_LAND_HINTS: 'true' },
      input: { repo: 'owner/repo', manifest_path: manifestPath }
    });
    expect(envEffective.values.limit).toBe(9);
    expect(envEffective.values.land_hints).toBe(true);
    expect(envEffective.provenance.limit.layer).toBe('env');

    const inputEffective = await loadEffectiveConfig({
      userPath: path.join(dir, 'missing-user.json'),
      repoPath: path.join(dir, 'missing-repo.json'),
      env: {},
      input: { repo: 'owner/repo', manifest_path: manifestPath, limit: 6, land_hints: true }
    });
    expect(inputEffective.values.limit).toBe(6);
    expect(inputEffective.values.land_hints).toBe(true);
    expect(inputEffective.provenance.limit.layer).toBe('input');
  });

  it('fails hunt target resolution when a manifest implies both one repo and one org', async () => {
    const dir = await tempDir('gitworthy-config-ambiguous-');
    const manifestPath = path.join(dir, 'targets.json');
    await writeJson(manifestPath, {
      schema_version: '1.0-draft.1',
      repos: ['owner/repo'],
      orgs: ['owner']
    });
    const effective = await loadEffectiveConfig({
      userPath: path.join(dir, 'missing-user.json'),
      repoPath: path.join(dir, 'missing-repo.json'),
      env: {},
      input: { manifest_path: manifestPath }
    });

    expect(() => resolveHuntFromConfig({}, effective)).toThrow(/resolved both one repo and one org/);
  });

  it('treats an empty init skeleton profile as no profile for show', async () => {
    const effective = await loadEffectiveConfig({
      userPath: '/tmp/gitworthy-does-not-exist-user.json',
      repoPath: '/tmp/gitworthy-does-not-exist-repo.json',
      env: {},
      input: { skill_profile: { languages: [], topics: [], preferred_ecosystems: [], avoid: [] } }
    });
    expect(profileForShow(effective)).toBeNull();
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

  it('rejects token-like effective env values before CLI config show prints them', async () => {
    const previous = process.env.GITWORTHY_SKILL_PROFILE;
    process.env.GITWORTHY_SKILL_PROFILE = 'languages=ghp_abcdefghijklmnopqrstuvwxyz123456';
    try {
      const result = await run(['config', 'show', '--effective', '--json']);
      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stdout);
      expect(payload.error.code).toBe('config_secret_detected');
    } finally {
      if (previous === undefined) delete process.env.GITWORTHY_SKILL_PROFILE;
      else process.env.GITWORTHY_SKILL_PROFILE = previous;
    }
  });

  it('returns structured MCP errors for manifest_path-only ambiguous hunt targets', async () => {
    const dir = await tempDir('gitworthy-mcp-ambiguous-');
    const manifestPath = path.join(dir, 'targets.json');
    await writeJson(manifestPath, {
      schema_version: '1.0-draft.1',
      repos: ['owner/repo'],
      orgs: ['owner']
    });

    const payload = await callMcpTool('hunt', { manifest_path: manifestPath });
    expect(payload.ok).toBe(false);
    expect((payload.error as Record<string, unknown>).code).toBe('hunt_ambiguous_manifest_target');
  });

  it('returns structured MCP errors after config resolution when org remains unresolved', async () => {
    const payload = await callMcpTool('org_scan', {});
    expect(payload.ok).toBe(false);
    expect((payload.error as Record<string, unknown>).code).toBe('invalid_org_ref');
  });
});
