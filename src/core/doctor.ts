import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { cacheRoot } from '../lib/cache.js';
import { githubJson, githubToken } from '../lib/github.js';
import { packageVersion } from '../lib/package-meta.js';
import { npmMetadata } from '../lib/registry.js';
import { storeRoot } from '../lib/store-fs.js';
import { findTrackODebt } from '../lib/outcome-reconcile.js';
import { createEnvelope, Envelope } from './envelope.js';

export const CAPABILITIES_VERSION = 2 as const;

export type CapabilityStatus = 'pass' | 'warn' | 'fail' | 'skipped' | 'inconclusive';

export type Capability = {
  id: string;
  status: CapabilityStatus;
  summary: string;
  remediation?: string;
  detail?: Record<string, unknown>;
};

export type Input = {
  probe_repo?: string;
  probe_issue_number?: number;
  /** When true, include optional heavier probes (safe ls-remote). */
  full?: boolean;
};

type RateLimitResponse = { resources: { core: { limit: number; remaining: number; reset: number } } };
type GithubUser = { login: string };
type TimelineEvent = { event: string };

type StepResult = { evidence: Record<string, unknown>; checked: string[]; not_checked: string[] };

const DEFAULT_PROBE_REPO = 'trippyogi/gitworthy';
const DEFAULT_PROBE_ISSUE_NUMBER = 1;
const RATE_LIMIT_LOW_THRESHOLD = 100;
const MIN_NODE_MAJOR = 22;
const BASELINE_LIMITATION = 'doctor validates the local environment and a small live GitHub API surface (rate limit, auth, timeline capability); it does not validate permissions against an arbitrary target repo or exercise the full worth_check pipeline.';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capability(
  id: string,
  status: CapabilityStatus,
  summary: string,
  remediation?: string,
  detail?: Record<string, unknown>
): Capability {
  return {
    id,
    status,
    summary,
    ...(remediation ? { remediation } : {}),
    ...(detail ? { detail } : {})
  };
}

async function checkNode(): Promise<{ capability: Capability; evidence: Record<string, unknown>; checked: string[] }> {
  const version = process.versions.node;
  const major = Number(version.split('.')[0] ?? 0);
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR;
  return {
    evidence: { kind: 'node', version, major, min_major: MIN_NODE_MAJOR },
    checked: [`checked Node.js version (${version})`],
    capability: ok
      ? capability('node', 'pass', `Node.js ${version} meets the minimum (>= ${MIN_NODE_MAJOR}).`)
      : capability(
        'node',
        'fail',
        `Node.js ${version} is below the minimum (>= ${MIN_NODE_MAJOR}).`,
        `Upgrade Node.js to ${MIN_NODE_MAJOR}+ (see package.json engines).`,
        { version, major, min_major: MIN_NODE_MAJOR }
      )
  };
}

async function checkGit(): Promise<{ capability: Capability; evidence: Record<string, unknown>; checked: string[]; not_checked: string[] }> {
  try {
    const { stdout } = await execa('git', ['--version'], { timeout: 10_000 });
    const version = stdout.trim();
    return {
      evidence: { kind: 'git', version, available: true },
      checked: [`checked git is available (${version})`],
      not_checked: [],
      capability: capability('git', 'pass', `${version} is available for ls-remote and object inspection.`)
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'git', available: false, error: message },
      checked: [],
      not_checked: [`git was not available: ${message}`],
      capability: capability(
        'git',
        'fail',
        'git is not available on PATH.',
        'Install git and ensure `git --version` works in this environment.',
        { error: message }
      )
    };
  }
}

async function checkCacheDir(): Promise<StepResult & { writable: boolean; capability: Capability }> {
  const dir = cacheRoot();
  try {
    await mkdir(dir, { recursive: true });
    const probeFile = path.join(dir, `.doctor-probe-${randomUUID()}`);
    await writeFile(probeFile, 'ok');
    await unlink(probeFile);
    return {
      evidence: { kind: 'cache', dir, writable: true },
      checked: [`checked cache directory exists and is writable (${dir})`],
      not_checked: [],
      writable: true,
      capability: capability('cache_dir', 'pass', `Cache directory is writable (${dir}).`)
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'cache', dir, writable: false, error: message },
      checked: [],
      not_checked: [`cache directory (${dir}) is not writable: ${message}`],
      writable: false,
      capability: capability(
        'cache_dir',
        'fail',
        `Cache directory is not writable (${dir}).`,
        'Fix permissions or set GITWORTHY_CACHE_DIR to a writable path.',
        { dir, error: message }
      )
    };
  }
}

async function checkDataStore(): Promise<{
  capability: Capability;
  evidence: Record<string, unknown>;
  checked: string[];
  not_checked: string[];
}> {
  const dir = storeRoot();
  const locksDir = path.join(dir, '.locks');
  const indexesDir = path.join(dir, 'indexes');
  const migrationsDir = path.join(dir, 'migrations');
  const quarantineDir = path.join(dir, 'ledger', 'quarantine');
  try {
    await mkdir(dir, { recursive: true });
    const probeFile = path.join(dir, `.doctor-probe-${randomUUID()}`);
    await writeFile(probeFile, 'ok');
    await unlink(probeFile);

    let staleLocks = 0;
    let quarantineCount = 0;
    let migrationMarkers = 0;
    let indexTargets = 0;
    try {
      await access(locksDir, fsConstants.F_OK);
      const locks = await readdir(locksDir);
      for (const name of locks) {
        if (!name.endsWith('.lock')) continue;
        try {
          const info = await stat(path.join(locksDir, name));
          if (Date.now() - info.mtimeMs > 30_000) staleLocks += 1;
        } catch {
          // ignore per-lock stat failures
        }
      }
    } catch {
      // locks dir may not exist yet
    }
    try {
      const markers = await readdir(migrationsDir);
      migrationMarkers = markers.filter((name) => name.endsWith('.json')).length;
    } catch {
      // no migrations yet
    }
    try {
      const targetsDir = path.join(indexesDir, 'targets');
      const targets = await readdir(targetsDir);
      indexTargets = targets.length;
    } catch {
      // indexes optional until first write
    }
    try {
      const quarantined = await readdir(quarantineDir);
      quarantineCount = quarantined.length;
    } catch {
      // quarantine optional
    }

    const warnings: string[] = [];
    if (staleLocks > 0) warnings.push(`${staleLocks} stale lock file(s) (>30s)`);
    if (quarantineCount > 0) warnings.push(`${quarantineCount} quarantined ledger blob(s)`);

    let trackODebt = 0;
    try {
      const debt = await findTrackODebt();
      trackODebt = debt.count;
      if (trackODebt > 0) warnings.push(`Track O debt: ${trackODebt} open-lane target(s) without terminal`);
    } catch {
      // Store may be empty / unreadable for outcomes; data_store writability already checked.
    }

    const detail = {
      dir,
      writable: true,
      stale_locks: staleLocks,
      quarantine_count: quarantineCount,
      migration_markers: migrationMarkers,
      index_targets: indexTargets,
      track_o_debt: trackODebt
    };

    if (warnings.length > 0) {
      const remediations: string[] = [];
      if (staleLocks > 0) {
        remediations.push(
          'Inspect ~/.gitworthy/store/.locks (or GITWORTHY_STORE_DIR). Remove only locks older than the stale window after confirming no live process holds them. Rebuild indexes with `gitworthy store rebuild-indexes` if needed.'
        );
      }
      if (quarantineCount > 0) {
        remediations.push(
          'Review quarantined records under the ledger quarantine directory; re-run `gitworthy ledger migrate` or rebuild indexes if schemas look inconsistent.'
        );
      }
      if (trackODebt > 0) {
        remediations.push(
          'Run `gitworthy outcome reconcile` (dry-run) then `gitworthy outcome reconcile --write` for clear terminals. Ambiguous closes need manual `outcome record`.'
        );
      }
      return {
        evidence: { kind: 'data_store', ...detail },
        checked: [
          `checked data store directory is writable (${dir})`,
          `checked Track O debt (${trackODebt})`
        ],
        not_checked: [],
        capability: capability(
          'data_store',
          'warn',
          `Data store is writable but needs attention: ${warnings.join('; ')}.`,
          remediations.join(' '),
          detail
        )
      };
    }

    return {
      evidence: { kind: 'data_store', ...detail },
      checked: [
        `checked data store directory is writable (${dir})`,
        `checked Track O debt (${trackODebt})`
      ],
      not_checked: [],
      capability: capability(
        'data_store',
        'pass',
        `Data store is writable (${dir}); migrations=${migrationMarkers}, index targets=${indexTargets}, Track O debt=${trackODebt}.`,
        undefined,
        detail
      )
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'data_store', dir, writable: false, error: message },
      checked: [],
      not_checked: [`data store (${dir}) is not writable: ${message}`],
      capability: capability(
        'data_store',
        'fail',
        `Data store is not writable (${dir}).`,
        'Fix permissions or set GITWORTHY_STORE_DIR to a writable path.',
        { dir, error: message }
      )
    };
  }
}

async function checkVersion(): Promise<StepResult & { capability: Capability }> {
  const local = packageVersion();
  try {
    const metadata = await npmMetadata('gitworthy');
    const latest = metadata['dist-tags']?.latest;
    const upToDate = latest ? local === latest : null;
    const status: CapabilityStatus = upToDate === false ? 'warn' : 'pass';
    return {
      evidence: { kind: 'version', local, npm_latest: latest ?? null, up_to_date: upToDate },
      checked: ['checked local package version', 'fetched npm registry latest version for gitworthy'],
      not_checked: [],
      capability: capability(
        'npm_registry',
        status,
        upToDate === false
          ? `Installed gitworthy@${local}; npm latest is ${latest}.`
          : `npm registry reachable; installed gitworthy@${local}${latest ? ` (latest ${latest})` : ''}.`,
        upToDate === false ? 'Upgrade with `npm i -g gitworthy@latest` (or your package manager equivalent) when ready.' : undefined,
        { local, npm_latest: latest ?? null }
      )
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'version', local, npm_latest: null },
      checked: ['checked local package version'],
      not_checked: [`npm registry latest version for gitworthy was not checked: ${message}`],
      capability: capability(
        'npm_registry',
        'warn',
        `npm registry latest version was not checked: ${message}`,
        'Check network access to registry.npmjs.org; release-gap checks may be degraded.',
        { local, error: message }
      )
    };
  }
}

async function checkRateLimit(): Promise<StepResult & { low: boolean | null; capability: Capability }> {
  try {
    const response = await githubJson<RateLimitResponse>('/rate_limit');
    const core = response.resources.core;
    const low = core.remaining < RATE_LIMIT_LOW_THRESHOLD;
    return {
      evidence: { kind: 'rate_limit', remaining: core.remaining, limit: core.limit, reset: core.reset },
      checked: ['fetched GitHub rate limit status (/rate_limit)'],
      not_checked: [],
      low,
      capability: low
        ? capability(
          'github_rate_limit',
          'warn',
          `GitHub core rate limit is low (${core.remaining}/${core.limit}).`,
          'Wait for reset or use a higher-limit token before large hunt/scan runs.',
          { remaining: core.remaining, limit: core.limit, reset: core.reset }
        )
        : capability(
          'github_rate_limit',
          'pass',
          `GitHub core rate limit ok (${core.remaining}/${core.limit}).`,
          undefined,
          { remaining: core.remaining, limit: core.limit, reset: core.reset }
        )
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'rate_limit', ok: false, error: message },
      checked: [],
      not_checked: [`GitHub rate limit was not checked: ${message}`],
      low: null,
      capability: capability(
        'github_rate_limit',
        'fail',
        `GitHub rate limit check failed: ${message}`,
        'Verify GITHUB_TOKEN/GH_TOKEN and network access to api.github.com.',
        { error: message }
      )
    };
  }
}

async function checkAuth(): Promise<StepResult & { ok: boolean; capability: Capability }> {
  try {
    const user = await githubJson<GithubUser>('/user');
    return {
      evidence: { kind: 'auth', ok: true, login: user.login },
      checked: ['fetched authenticated GitHub user (/user)'],
      not_checked: [],
      ok: true,
      capability: capability('github_auth', 'pass', `Authenticated to GitHub as ${user.login}.`, undefined, { login: user.login })
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'auth', ok: false, error: message },
      checked: [],
      not_checked: [`GitHub authentication was not verified: ${message}`],
      ok: false,
      capability: capability(
        'github_auth',
        'fail',
        `GitHub authentication failed: ${message}`,
        'Set a valid GITHUB_TOKEN or GH_TOKEN with repo/issues read access.',
        { error: message }
      )
    };
  }
}

async function checkTimelineProbe(repo: string, issueNumber: number): Promise<StepResult & { capability: Capability }> {
  try {
    const events = await githubJson<TimelineEvent[]>(`/repos/${repo}/issues/${issueNumber}/timeline?per_page=5`);
    const types = [...new Set(events.map((event) => event.event))].sort();
    const not_checked: string[] = [];
    if (!types.includes('cross-referenced')) {
      not_checked.push(
        `timeline probe on ${repo}#${issueNumber} observed no cross-referenced events; weak tokens (classic PATs without Issues: Read, or fine-grained tokens missing an Issues permission) omit cross-referenced events from the timeline API, which would under-count linked PRs in linked_work.`
      );
      return {
        evidence: { kind: 'timeline_probe', repo, issue_number: issueNumber, event_count: events.length, event_types: types },
        checked: [`probed timeline capability on ${repo}#${issueNumber}`],
        not_checked,
        capability: capability(
          'github_timeline',
          'inconclusive',
          `Timeline reachable on controlled fixture ${repo}#${issueNumber}, but no cross-referenced events were observed.`,
          'If linked_work under-counts PRs, grant Issues: Read (classic) or the fine-grained Issues permission and re-run doctor against the known fixture.',
          { repo, issue_number: issueNumber, event_types: types }
        )
      };
    }
    return {
      evidence: { kind: 'timeline_probe', repo, issue_number: issueNumber, event_count: events.length, event_types: types },
      checked: [`probed timeline capability on ${repo}#${issueNumber}`],
      not_checked,
      capability: capability(
        'github_timeline',
        'pass',
        `Timeline cross-references visible on controlled fixture ${repo}#${issueNumber}.`,
        undefined,
        { repo, issue_number: issueNumber, event_types: types }
      )
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'timeline_probe', repo, issue_number: issueNumber, ok: false, error: message },
      checked: [],
      not_checked: [`timeline capability probe on ${repo}#${issueNumber} was not checked: ${message}`],
      capability: capability(
        'github_timeline',
        'inconclusive',
        `Timeline capability probe on controlled fixture ${repo}#${issueNumber} failed: ${message}`,
        'Confirm the fixture is reachable and the token can read issues/timeline; do not infer timeline scope from an arbitrary quiet issue.',
        { repo, issue_number: issueNumber, error: message }
      )
    };
  }
}

async function checkSafeLsRemote(repo: string): Promise<{ capability: Capability; evidence: Record<string, unknown>; checked: string[]; not_checked: string[] }> {
  try {
    const { stdout } = await execa('git', ['ls-remote', '--heads', `https://github.com/${repo}.git`], { timeout: 20_000 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    return {
      evidence: { kind: 'git_ls_remote', repo, heads: lines.length },
      checked: [`safe git ls-remote against ${repo} (${lines.length} heads)`],
      not_checked: [],
      capability: capability('git_ls_remote', 'pass', `Safe ls-remote succeeded for ${repo} (${lines.length} heads).`)
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'git_ls_remote', repo, ok: false, error: message },
      checked: [],
      not_checked: [`safe git ls-remote against ${repo} failed: ${message}`],
      capability: capability(
        'git_ls_remote',
        'warn',
        `Safe ls-remote failed for ${repo}: ${message}`,
        'Check network/git access to GitHub; branch and release probes may be degraded.',
        { repo, error: message }
      )
    };
  }
}

function overallVerdict(capabilities: Capability[]): { verdict: 'ACT' | 'VERIFY' | 'SKIP'; verdict_summary: string } {
  const fails = capabilities.filter((item) => item.status === 'fail');
  const warns = capabilities.filter((item) => item.status === 'warn' || item.status === 'inconclusive');
  if (fails.length > 0) {
    return {
      verdict: 'SKIP',
      verdict_summary: `not ready: ${fails.map((item) => item.summary).join(' ')}`
    };
  }
  if (warns.length > 0) {
    return {
      verdict: 'VERIFY',
      verdict_summary: `ready with caution: ${warns.map((item) => item.summary).join(' ')}`
    };
  }
  return {
    verdict: 'ACT',
    verdict_summary: 'ready: token present, GitHub auth and rate limit checked, cache and data directories writable.'
  };
}

export async function doctor(input: Input = {}): Promise<Envelope & {
  capabilities_version: typeof CAPABILITIES_VERSION;
  capabilities: Capability[];
  verdict: 'ACT' | 'VERIFY' | 'SKIP';
}> {
  const probeRepo = input.probe_repo ?? DEFAULT_PROBE_REPO;
  const probeIssueNumber = input.probe_issue_number ?? DEFAULT_PROBE_ISSUE_NUMBER;
  const token = githubToken();
  const capabilities: Capability[] = [];

  const evidence: Array<Record<string, unknown>> = [{ kind: 'auth', token_present: Boolean(token) }];
  const checked: string[] = ['checked for a GITHUB_TOKEN or GH_TOKEN environment variable'];
  const not_checked: string[] = [BASELINE_LIMITATION];

  const [nodeResult, gitResult, cacheResult, dataResult, versionResult] = await Promise.all([
    checkNode(),
    checkGit(),
    checkCacheDir(),
    checkDataStore(),
    checkVersion()
  ]);

  evidence.push(nodeResult.evidence, gitResult.evidence, cacheResult.evidence, dataResult.evidence, versionResult.evidence);
  checked.push(...nodeResult.checked, ...gitResult.checked, ...cacheResult.checked, ...dataResult.checked, ...versionResult.checked);
  not_checked.push(...gitResult.not_checked, ...cacheResult.not_checked, ...dataResult.not_checked, ...versionResult.not_checked);
  capabilities.push(
    nodeResult.capability,
    gitResult.capability,
    token
      ? capability('github_token', 'pass', 'GITHUB_TOKEN or GH_TOKEN is present.')
      : capability(
        'github_token',
        'fail',
        'GITHUB_TOKEN (or GH_TOKEN) is missing.',
        'Export GITHUB_TOKEN or GH_TOKEN before running GitHub-backed commands.'
      ),
    cacheResult.capability,
    dataResult.capability,
    versionResult.capability
  );

  let authOk: boolean | null = null;
  let rateLimitLow: boolean | null = null;

  if (!token) {
    not_checked.push('GitHub rate limit, authentication, and timeline capability were not checked because no GITHUB_TOKEN or GH_TOKEN is present.');
    capabilities.push(
      capability('github_auth', 'skipped', 'GitHub authentication skipped; no token present.', 'Set GITHUB_TOKEN or GH_TOKEN.'),
      capability('github_rate_limit', 'skipped', 'GitHub rate limit skipped; no token present.', 'Set GITHUB_TOKEN or GH_TOKEN.'),
      capability('github_timeline', 'skipped', 'Timeline capability skipped; no token present.', 'Set GITHUB_TOKEN or GH_TOKEN.')
    );
  } else {
    const [rateLimitResult, authResult] = await Promise.all([checkRateLimit(), checkAuth()]);
    evidence.push(rateLimitResult.evidence, authResult.evidence);
    checked.push(...rateLimitResult.checked, ...authResult.checked);
    not_checked.push(...rateLimitResult.not_checked, ...authResult.not_checked);
    rateLimitLow = rateLimitResult.low;
    authOk = authResult.ok;
    capabilities.push(authResult.capability, rateLimitResult.capability);

    if (authOk) {
      const timelineResult = await checkTimelineProbe(probeRepo, probeIssueNumber);
      evidence.push(timelineResult.evidence);
      checked.push(...timelineResult.checked);
      not_checked.push(...timelineResult.not_checked);
      capabilities.push(timelineResult.capability);
    } else {
      not_checked.push('timeline capability was not checked because GitHub authentication failed.');
      capabilities.push(
        capability('github_timeline', 'skipped', 'Timeline capability skipped because authentication failed.', 'Fix github_auth first.')
      );
    }
  }

  if (input.full) {
    const lsRemote = await checkSafeLsRemote(probeRepo);
    evidence.push(lsRemote.evidence);
    checked.push(...lsRemote.checked);
    not_checked.push(...lsRemote.not_checked);
    capabilities.push(lsRemote.capability);
  } else {
    capabilities.push(
      capability('git_ls_remote', 'skipped', 'Safe ls-remote self-test skipped (pass --full to enable).', 'Re-run `gitworthy doctor --full` for release validation.')
    );
  }

  // Preserve prior summary wording for the common ready / not-ready paths when possible.
  let { verdict, verdict_summary } = overallVerdict(capabilities);
  if (!token) {
    verdict = 'SKIP';
    verdict_summary = 'not ready: GITHUB_TOKEN (or GH_TOKEN) is missing.';
  } else if (authOk === false) {
    verdict = 'SKIP';
    verdict_summary = 'not ready: GitHub authentication failed; the token may be invalid, expired, or revoked.';
  } else if (!cacheResult.writable) {
    verdict = 'SKIP';
    verdict_summary = `not ready: cache directory (${cacheResult.evidence.dir}) is not writable.`;
  } else if (rateLimitLow && verdict !== 'SKIP') {
    verdict = 'VERIFY';
    verdict_summary = 'ready with caution: GitHub rate limit is low; checks may fail mid-run.';
  } else if (verdict === 'ACT') {
    verdict_summary = 'ready: token present, GitHub auth and rate limit checked, cache directory writable.';
  }

  const envelope = createEnvelope({
    verdict_summary,
    evidence,
    signals: [],
    checked: [...new Set(checked)],
    not_checked: [...new Set(not_checked)],
    cached: false
  });

  return {
    ...envelope,
    capabilities_version: CAPABILITIES_VERSION,
    capabilities,
    verdict
  };
}
