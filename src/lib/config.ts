import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ZodError } from 'zod';
import { GitworthyError } from '../core/envelope.js';
import {
  CONFIG_SCHEMA_VERSION,
  ConfigFileSchema,
  TargetManifestSchema,
  type ConfigDefaults,
  type ConfigFile,
  type SkillProfileV1,
  type TargetManifest,
  type TargetOrgEntry,
  type TargetRepoEntry
} from '../contracts/index.js';
import { writeJsonAtomic } from './store-fs.js';

export type ConfigLayer = 'defaults' | 'user' | 'repo' | 'env' | 'input' | 'manifest';
export type ConfigSource = { layer: ConfigLayer; path?: string; detail?: string };
export type EffectiveConfigValues = ConfigDefaults & { skill_profile?: SkillProfileV1 | string; target_manifest?: TargetManifest };
export type EffectiveConfig = {
  schema_version: typeof CONFIG_SCHEMA_VERSION;
  values: EffectiveConfigValues;
  provenance: Record<string, ConfigSource>;
  paths: { user: string; repo: string; manifest?: string };
  loaded: Array<{ layer: 'user' | 'repo' | 'manifest'; path: string; present: boolean }>;
};

type PathJoin = Pick<typeof path, 'join'>;
type Env = Record<string, string | undefined>;

const BUILT_IN_DEFAULTS: EffectiveConfigValues = {
  limit: 25,
  scan_limit: 25,
  max_repos: 8,
  max_checks: 3,
  land_hints: true,
  skip_likely_land_only: true,
  skip_soft_ask: true,
  skip_assigned: true,
  skip_ledger_skip: true,
  skip_policy_gate: false
};

const SECRET_KEY_PATTERN = /(?:^|[_-])(token|secret|password|authorization|credential|api[_-]?key)(?:$|[_-])/i;
const SECRET_VALUE_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  /\b(?=[A-Za-z0-9_+=/-]{40,}\b)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_+=/-]{40,}\b/
];

const LAYER_RANK: Record<ConfigLayer, number> = {
  defaults: 0,
  user: 1,
  repo: 2,
  manifest: 3,
  env: 4,
  input: 5
};

export function userConfigPath(homeDir = homedir(), pathImpl: PathJoin = path): string {
  return pathImpl.join(homeDir, '.gitworthy', 'config.json');
}

export function repoConfigPath(repoRoot = process.cwd(), pathImpl: PathJoin = path): string {
  return pathImpl.join(repoRoot, '.gitworthy', 'config.json');
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function discoverRepoRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    if (await pathExists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function inputError(code: string, message: string, pathLabel?: string): GitworthyError {
  return new GitworthyError({
    code,
    message,
    checked: ['validated gitworthy config input'],
    not_checked: [pathLabel ? `${message} (${pathLabel})` : message]
  });
}

function zodMessage(prefix: string, error: ZodError): string {
  const issue = error.issues[0];
  const label = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${prefix}${label}${issue?.message ?? 'invalid config'}`;
}

export function assertSecretFree(value: unknown, label = 'config'): void {
  const visit = (item: unknown, trail: string[]): void => {
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, [...trail, String(index)]));
      return;
    }
    if (!item || typeof item !== 'object') {
      if (typeof item === 'string' && SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(item))) {
        throw inputError('config_secret_detected', `${label} contains a token-like value at ${trail.join('.') || '<root>'}. Store tokens in GITHUB_TOKEN or GH_TOKEN only.`);
      }
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      const nextTrail = [...trail, key];
      if (SECRET_KEY_PATTERN.test(key)) {
        throw inputError('config_secret_detected', `${label} contains secret-like key ${nextTrail.join('.')}. Store tokens in GITHUB_TOKEN or GH_TOKEN only.`);
      }
      visit(child, nextTrail);
    }
  };
  visit(value, []);
}

function parseConfigFile(raw: unknown, file: string): ConfigFile {
  assertSecretFree(raw, file);
  const result = ConfigFileSchema.safeParse(raw);
  if (!result.success) throw inputError('config_invalid', zodMessage(`Invalid config ${file}: `, result.error), file);
  return result.data;
}

function parseTargetManifest(raw: unknown, file: string): TargetManifest {
  assertSecretFree(raw, file);
  const result = TargetManifestSchema.safeParse(raw);
  if (!result.success) {
    const ambiguous = result.error.issues.some((issue) => issue.message.includes('ambiguous npm package mapping'));
    throw inputError(ambiguous ? 'manifest_ambiguous_package_mapping' : 'manifest_invalid', zodMessage(`Invalid target manifest ${file}: `, result.error), file);
  }
  return result.data;
}

async function readJsonIfPresent(file: string): Promise<{ present: boolean; value?: unknown }> {
  try {
    return { present: true, value: JSON.parse(await readFile(file, 'utf8')) };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'ENOENT') return { present: false };
    if (error instanceof SyntaxError) throw inputError('config_invalid_json', `Invalid JSON in ${file}: ${error.message}`, file);
    throw error;
  }
}

function setValue(values: EffectiveConfigValues, provenance: Record<string, ConfigSource>, key: keyof EffectiveConfigValues, value: unknown, source: ConfigSource): void {
  if (value === undefined) return;
  (values as Record<string, unknown>)[key] = value;
  provenance[String(key)] = source;
}

function applyValues(values: EffectiveConfigValues, provenance: Record<string, ConfigSource>, defaults: Partial<EffectiveConfigValues>, source: ConfigSource): void {
  for (const [key, value] of Object.entries(defaults) as Array<[keyof EffectiveConfigValues, unknown]>) setValue(values, provenance, key, value, source);
}

function envBoolean(value: string | undefined, name: string): boolean | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw inputError('config_invalid_env', `${name} must be a boolean (true/false, 1/0, yes/no, on/off).`);
}

function envNumber(value: string | undefined, name: string, max: number): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw inputError('config_invalid_env', `${name} must be an integer from 1 to ${max}.`);
  return parsed;
}

function envList(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const list = value.split(',').map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function envConfig(env: Env): Partial<EffectiveConfigValues> {
  return {
    label: env.GITWORTHY_LABEL,
    keywords: envList(env.GITWORTHY_KEYWORDS),
    since: env.GITWORTHY_SINCE,
    limit: envNumber(env.GITWORTHY_LIMIT, 'GITWORTHY_LIMIT', 100),
    scan_limit: envNumber(env.GITWORTHY_SCAN_LIMIT, 'GITWORTHY_SCAN_LIMIT', 100),
    max_repos: envNumber(env.GITWORTHY_MAX_REPOS, 'GITWORTHY_MAX_REPOS', 20),
    max_checks: envNumber(env.GITWORTHY_MAX_CHECKS, 'GITWORTHY_MAX_CHECKS', 5),
    land_hints: envBoolean(env.GITWORTHY_LAND_HINTS, 'GITWORTHY_LAND_HINTS'),
    skip_likely_land_only: envBoolean(env.GITWORTHY_SKIP_LIKELY_LAND_ONLY, 'GITWORTHY_SKIP_LIKELY_LAND_ONLY'),
    skip_soft_ask: envBoolean(env.GITWORTHY_SKIP_SOFT_ASK, 'GITWORTHY_SKIP_SOFT_ASK'),
    skip_assigned: envBoolean(env.GITWORTHY_SKIP_ASSIGNED, 'GITWORTHY_SKIP_ASSIGNED'),
    skip_ledger_skip: envBoolean(env.GITWORTHY_SKIP_LEDGER_SKIP, 'GITWORTHY_SKIP_LEDGER_SKIP'),
    skip_policy_gate: envBoolean(env.GITWORTHY_SKIP_POLICY_GATE, 'GITWORTHY_SKIP_POLICY_GATE'),
    npm_package: env.GITWORTHY_NPM_PACKAGE,
    skill_profile: env.GITWORTHY_SKILL_PROFILE,
    manifest_path: env.GITWORTHY_TARGET_MANIFEST ?? env.GITWORTHY_MANIFEST_PATH
  };
}

function configLayerValues(config: ConfigFile): Partial<EffectiveConfigValues> {
  return { ...config.defaults, skill_profile: config.profile, target_manifest: config.manifest, manifest_path: config.manifest_path ?? config.defaults?.manifest_path };
}

function firstRepo(manifest: TargetManifest): string | undefined {
  if ((manifest.repos ?? []).length !== 1) return undefined;
  const entry = manifest.repos![0];
  return typeof entry === 'string' ? entry : entry.repo;
}

function firstOrg(manifest: TargetManifest): string | undefined {
  if ((manifest.orgs ?? []).length !== 1) return undefined;
  const entry = manifest.orgs![0];
  return typeof entry === 'string' ? entry : entry.org;
}

function repoOf(entry: TargetRepoEntry): string { return typeof entry === 'string' ? entry : entry.repo; }
function orgOf(entry: TargetOrgEntry): string { return typeof entry === 'string' ? entry : entry.org; }

function applyTargetOverrides(values: EffectiveConfigValues, provenance: Record<string, ConfigSource>, manifest: TargetManifest, source: ConfigSource, target: { repo?: string; org?: string }): void {
  const rows = [
    target.repo ? manifest.repos?.find((entry) => repoOf(entry) === target.repo && typeof entry !== 'string') : undefined,
    target.org ? manifest.orgs?.find((entry) => orgOf(entry) === target.org && typeof entry !== 'string') : undefined,
    manifest.target_overrides?.find((entry) => (target.repo && entry.repo === target.repo) || (target.org && entry.org === target.org))
  ];
  for (const row of rows) {
    if (!row || typeof row === 'string') continue;
    const rowValues = row as Partial<EffectiveConfigValues>;
    for (const key of ['label', 'keywords', 'since', 'limit', 'max_repos', 'land_hints', 'npm_package'] as const) {
      const currentLayer = provenance[key]?.layer ?? 'defaults';
      if (rowValues[key] !== undefined && LAYER_RANK[currentLayer] < LAYER_RANK[source.layer]) {
        setValue(values, provenance, key, rowValues[key], source);
      }
    }
    const profileLayer = provenance.skill_profile?.layer ?? 'defaults';
    if (rowValues.skill_profile !== undefined && LAYER_RANK[profileLayer] < LAYER_RANK[source.layer]) {
      setValue(values, provenance, 'skill_profile', rowValues.skill_profile, source);
    }
  }
  if (target.repo && LAYER_RANK[provenance.npm_package?.layer ?? 'defaults'] < LAYER_RANK[source.layer]) {
    const mapping = manifest.package_mappings?.find((item) => item.repo === target.repo);
    if (mapping) setValue(values, provenance, 'npm_package', mapping.npm_package, source);
  }
}

export async function loadEffectiveConfig(options: {
  cwd?: string;
  homeDir?: string;
  env?: Env;
  input?: Partial<EffectiveConfigValues> & { repo?: string; org?: string };
  userPath?: string;
  repoPath?: string;
} = {}): Promise<EffectiveConfig> {
  const repoRoot = options.cwd ? await discoverRepoRoot(options.cwd) : await discoverRepoRoot();
  const userPath = options.userPath ?? userConfigPath(options.homeDir);
  const repoPath = options.repoPath ?? repoConfigPath(repoRoot);
  const values: EffectiveConfigValues = {};
  const provenance: Record<string, ConfigSource> = {};
  const loaded: EffectiveConfig['loaded'] = [];
  applyValues(values, provenance, BUILT_IN_DEFAULTS, { layer: 'defaults', detail: 'built-in defaults' });

  for (const item of [{ layer: 'user' as const, path: userPath }, { layer: 'repo' as const, path: repoPath }]) {
    const raw = await readJsonIfPresent(item.path);
    loaded.push({ ...item, present: raw.present });
    if (raw.present) applyValues(values, provenance, configLayerValues(parseConfigFile(raw.value, item.path)), { layer: item.layer, path: item.path });
  }

  applyValues(values, provenance, envConfig(options.env ?? process.env), { layer: 'env', detail: 'GITWORTHY_* environment' });
  applyValues(values, provenance, options.input ?? {}, { layer: 'input', detail: 'CLI/MCP input' });

  let manifestPath = values.manifest_path;
  if (manifestPath && !path.isAbsolute(manifestPath)) manifestPath = path.resolve(repoRoot, manifestPath);
  if (manifestPath) {
    const raw = await readJsonIfPresent(manifestPath);
    loaded.push({ layer: 'manifest', path: manifestPath, present: raw.present });
    if (!raw.present) throw inputError('manifest_missing', `Target manifest not found: ${manifestPath}`, manifestPath);
    setValue(values, provenance, 'target_manifest', parseTargetManifest(raw.value, manifestPath), { layer: provenance.manifest_path?.layer ?? 'manifest', path: manifestPath });
  }
  if (values.target_manifest) {
    applyTargetOverrides(values, provenance, values.target_manifest, { layer: 'manifest', path: manifestPath }, {
      repo: typeof options.input?.repo === 'string' ? options.input.repo : firstRepo(values.target_manifest),
      org: typeof options.input?.org === 'string' ? options.input.org : firstOrg(values.target_manifest)
    });
  }

  return { schema_version: CONFIG_SCHEMA_VERSION, values, provenance, paths: { user: userPath, repo: repoPath, ...(manifestPath ? { manifest: manifestPath } : {}) }, loaded };
}

export function resolveScanFromConfig(input: { repo: string } & Partial<EffectiveConfigValues> & { max_pages?: number; explain_ranking?: boolean }, effective: EffectiveConfig): { repo: string } & Partial<EffectiveConfigValues> & { max_pages?: number; explain_ranking?: boolean } {
  return {
    repo: input.repo,
    label: input.label ?? effective.values.label,
    keywords: input.keywords ?? effective.values.keywords,
    since: input.since ?? effective.values.since,
    limit: input.limit ?? effective.values.limit,
    land_hints: input.land_hints ?? effective.values.land_hints,
    skill_profile: input.skill_profile ?? effective.values.skill_profile,
    ...(input.max_pages !== undefined ? { max_pages: input.max_pages } : {}),
    ...(input.explain_ranking !== undefined ? { explain_ranking: input.explain_ranking } : {})
  };
}

export function resolveOrgFromConfig(input: { org?: string } & Partial<EffectiveConfigValues> & { max_pages?: number; explain_ranking?: boolean }, effective: EffectiveConfig): { org: string } & Partial<EffectiveConfigValues> & { max_pages?: number; explain_ranking?: boolean; target_manifest?: TargetManifest } {
  const org = input.org ?? (effective.values.target_manifest ? firstOrg(effective.values.target_manifest) : undefined);
  if (!org) throw inputError('invalid_org_ref', 'org requires an org/user login or a manifest containing exactly one org.');
  return {
    org,
    label: input.label ?? effective.values.label,
    keywords: input.keywords ?? effective.values.keywords,
    since: input.since ?? effective.values.since,
    limit: input.limit ?? effective.values.limit,
    max_repos: input.max_repos ?? effective.values.max_repos,
    land_hints: input.land_hints ?? effective.values.land_hints,
    skill_profile: input.skill_profile ?? effective.values.skill_profile,
    ...(effective.values.target_manifest ? { target_manifest: effective.values.target_manifest } : {}),
    ...(input.max_pages !== undefined ? { max_pages: input.max_pages } : {}),
    ...(input.explain_ranking !== undefined ? { explain_ranking: input.explain_ranking } : {})
  };
}

export function resolveHuntFromConfig(input: { repo?: string; org?: string } & Partial<EffectiveConfigValues> & { explain_ranking?: boolean; max_pages?: number }, effective: EffectiveConfig): { repo?: string; org?: string } & Partial<EffectiveConfigValues> & { explain_ranking?: boolean; max_pages?: number; target_manifest?: TargetManifest } {
  const manifest = effective.values.target_manifest;
  const repo = input.repo ?? (manifest ? firstRepo(manifest) : undefined);
  const org = input.org ?? (manifest ? firstOrg(manifest) : undefined);
  if (!input.repo && !input.org && repo && org) {
    throw inputError('hunt_ambiguous_manifest_target', 'hunt manifest resolved both one repo and one org; provide repo or org explicitly.');
  }
  if (!repo && !org) throw inputError('hunt_invalid_input', 'hunt requires either repo, org, or a manifest containing exactly one target.');
  return {
    ...(repo ? { repo } : {}),
    ...(org ? { org } : {}),
    label: input.label ?? effective.values.label,
    keywords: input.keywords ?? effective.values.keywords,
    since: input.since ?? effective.values.since,
    scan_limit: input.scan_limit ?? input.limit ?? effective.values.scan_limit ?? effective.values.limit,
    max_repos: input.max_repos ?? effective.values.max_repos,
    max_checks: input.max_checks ?? effective.values.max_checks,
    land_hints: input.land_hints ?? effective.values.land_hints,
    skip_likely_land_only: input.skip_likely_land_only ?? effective.values.skip_likely_land_only,
    skip_soft_ask: input.skip_soft_ask ?? effective.values.skip_soft_ask,
    skip_assigned: input.skip_assigned ?? effective.values.skip_assigned,
    skip_ledger_skip: input.skip_ledger_skip ?? effective.values.skip_ledger_skip,
    skip_policy_gate: input.skip_policy_gate ?? effective.values.skip_policy_gate,
    npm_package: input.npm_package ?? effective.values.npm_package,
    skill_profile: input.skill_profile ?? effective.values.skill_profile,
    ...(manifest ? { target_manifest: manifest } : {}),
    ...(input.max_pages !== undefined ? { max_pages: input.max_pages } : {}),
    ...(input.explain_ranking !== undefined ? { explain_ranking: input.explain_ranking } : {})
  };
}

export function assertEffectiveConfigSafeToShow(effective: EffectiveConfig): void {
  assertSecretFree(effective.values, 'effective config');
}

export function profileForShow(effective: EffectiveConfig): SkillProfileV1 | string | null {
  const profile = effective.values.skill_profile;
  if (!profile) return null;
  if (typeof profile === 'string') return profile.trim().length > 0 ? profile : null;
  const hasTerms = Object.values(profile).some((value) => Array.isArray(value) && value.length > 0);
  return hasTerms ? profile : null;
}

export async function validateConfigSelection(input: { path?: string; user?: boolean; repo?: boolean; manifest_path?: string } = {}): Promise<{ ok: true; checked: Array<{ path: string; kind: 'config' | 'manifest'; present: boolean }> }> {
  const paths: Array<{ path: string; kind: 'config' | 'manifest' }> = [];
  if (input.path) paths.push({ path: input.path, kind: 'config' });
  else {
    if (input.user || (!input.user && !input.repo && !input.manifest_path)) paths.push({ path: userConfigPath(), kind: 'config' });
    if (input.repo || (!input.user && !input.repo && !input.manifest_path)) paths.push({ path: repoConfigPath(await discoverRepoRoot()), kind: 'config' });
  }
  if (input.manifest_path) paths.push({ path: input.manifest_path, kind: 'manifest' });
  const checked: Array<{ path: string; kind: 'config' | 'manifest'; present: boolean }> = [];
  for (const item of paths) {
    const raw = await readJsonIfPresent(item.path);
    checked.push({ ...item, present: raw.present });
    if (!raw.present) continue;
    if (item.kind === 'manifest') parseTargetManifest(raw.value, item.path);
    else parseConfigFile(raw.value, item.path);
  }
  return { ok: true, checked };
}

export function configSkeleton(): ConfigFile {
  return { schema_version: CONFIG_SCHEMA_VERSION, defaults: { limit: 25, max_repos: 8, max_checks: 3, land_hints: true }, profile: { languages: [], topics: [], preferred_ecosystems: [], avoid: [] } };
}

export async function writeConfigSkeleton(target: 'user' | 'repo', overwrite = false): Promise<{ path: string; created: boolean }> {
  const file = target === 'user' ? userConfigPath() : repoConfigPath(await discoverRepoRoot());
  if (!overwrite && await pathExists(file)) return { path: file, created: false };
  assertSecretFree(configSkeleton(), 'config skeleton');
  await writeJsonAtomic(file, configSkeleton());
  return { path: file, created: true };
}

export async function writeManifestSkeleton(file: string): Promise<void> {
  const manifest: TargetManifest = { schema_version: CONFIG_SCHEMA_VERSION, repos: [], orgs: [], package_mappings: [] };
  assertSecretFree(manifest, file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
