import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cacheRoot } from '../lib/cache.js';
import { githubJson, githubToken } from '../lib/github.js';
import { packageVersion } from '../lib/package-meta.js';
import { npmMetadata } from '../lib/registry.js';
import { createEnvelope, Envelope } from './envelope.js';

export type Input = {
  probe_repo?: string;
  probe_issue_number?: number;
};

type RateLimitResponse = { resources: { core: { limit: number; remaining: number; reset: number } } };
type GithubUser = { login: string };
type TimelineEvent = { event: string };

type StepResult = { evidence: Record<string, unknown>; checked: string[]; not_checked: string[] };

const DEFAULT_PROBE_REPO = 'trippyogi/gitworthy';
const DEFAULT_PROBE_ISSUE_NUMBER = 1;
const RATE_LIMIT_LOW_THRESHOLD = 100;
const BASELINE_LIMITATION = 'doctor validates the local environment and a small live GitHub API surface (rate limit, auth, timeline capability); it does not validate permissions against an arbitrary target repo or exercise the full worth_check pipeline.';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkCacheDir(): Promise<StepResult & { writable: boolean }> {
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
      writable: true
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'cache', dir, writable: false, error: message },
      checked: [],
      not_checked: [`cache directory (${dir}) is not writable: ${message}`],
      writable: false
    };
  }
}

async function checkVersion(): Promise<StepResult> {
  const local = packageVersion();
  try {
    const metadata = await npmMetadata('gitworthy');
    const latest = metadata['dist-tags']?.latest;
    return {
      evidence: { kind: 'version', local, npm_latest: latest ?? null, up_to_date: latest ? local === latest : null },
      checked: ['checked local package version', 'fetched npm registry latest version for gitworthy'],
      not_checked: []
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'version', local, npm_latest: null },
      checked: ['checked local package version'],
      not_checked: [`npm registry latest version for gitworthy was not checked: ${message}`]
    };
  }
}

async function checkRateLimit(): Promise<StepResult & { low: boolean | null }> {
  try {
    const response = await githubJson<RateLimitResponse>('/rate_limit');
    const core = response.resources.core;
    const low = core.remaining < RATE_LIMIT_LOW_THRESHOLD;
    return {
      evidence: { kind: 'rate_limit', remaining: core.remaining, limit: core.limit, reset: core.reset },
      checked: ['fetched GitHub rate limit status (/rate_limit)'],
      not_checked: [],
      low
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'rate_limit', ok: false, error: message },
      checked: [],
      not_checked: [`GitHub rate limit was not checked: ${message}`],
      low: null
    };
  }
}

async function checkAuth(): Promise<StepResult & { ok: boolean }> {
  try {
    const user = await githubJson<GithubUser>('/user');
    return {
      evidence: { kind: 'auth', ok: true, login: user.login },
      checked: ['fetched authenticated GitHub user (/user)'],
      not_checked: [],
      ok: true
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'auth', ok: false, error: message },
      checked: [],
      not_checked: [`GitHub authentication was not verified: ${message}`],
      ok: false
    };
  }
}

async function checkTimelineProbe(repo: string, issueNumber: number): Promise<StepResult> {
  try {
    const events = await githubJson<TimelineEvent[]>(`/repos/${repo}/issues/${issueNumber}/timeline?per_page=5`);
    const types = [...new Set(events.map((event) => event.event))].sort();
    const not_checked: string[] = [];
    if (!types.includes('cross-referenced')) {
      not_checked.push(
        `timeline probe on ${repo}#${issueNumber} observed no cross-referenced events; weak tokens (classic PATs without Issues: Read, or fine-grained tokens missing an Issues permission) omit cross-referenced events from the timeline API, which would under-count linked PRs in linked_work.`
      );
    }
    return {
      evidence: { kind: 'timeline_probe', repo, issue_number: issueNumber, event_count: events.length, event_types: types },
      checked: [`probed timeline capability on ${repo}#${issueNumber}`],
      not_checked
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      evidence: { kind: 'timeline_probe', repo, issue_number: issueNumber, ok: false, error: message },
      checked: [],
      not_checked: [`timeline capability probe on ${repo}#${issueNumber} was not checked: ${message}`]
    };
  }
}

export async function doctor(input: Input = {}): Promise<Envelope> {
  const probeRepo = input.probe_repo ?? DEFAULT_PROBE_REPO;
  const probeIssueNumber = input.probe_issue_number ?? DEFAULT_PROBE_ISSUE_NUMBER;
  const token = githubToken();

  const evidence: Array<Record<string, unknown>> = [{ kind: 'auth', token_present: Boolean(token) }];
  const checked: string[] = ['checked for a GITHUB_TOKEN or GH_TOKEN environment variable'];
  const not_checked: string[] = [BASELINE_LIMITATION];

  const [cacheResult, versionResult] = await Promise.all([checkCacheDir(), checkVersion()]);
  evidence.push(cacheResult.evidence, versionResult.evidence);
  checked.push(...cacheResult.checked, ...versionResult.checked);
  not_checked.push(...cacheResult.not_checked, ...versionResult.not_checked);

  let authOk: boolean | null = null;
  let rateLimitLow: boolean | null = null;

  if (!token) {
    not_checked.push('GitHub rate limit, authentication, and timeline capability were not checked because no GITHUB_TOKEN or GH_TOKEN is present.');
  } else {
    const [rateLimitResult, authResult] = await Promise.all([checkRateLimit(), checkAuth()]);
    evidence.push(rateLimitResult.evidence, authResult.evidence);
    checked.push(...rateLimitResult.checked, ...authResult.checked);
    not_checked.push(...rateLimitResult.not_checked, ...authResult.not_checked);
    rateLimitLow = rateLimitResult.low;
    authOk = authResult.ok;

    if (authOk) {
      const timelineResult = await checkTimelineProbe(probeRepo, probeIssueNumber);
      evidence.push(timelineResult.evidence);
      checked.push(...timelineResult.checked);
      not_checked.push(...timelineResult.not_checked);
    } else {
      not_checked.push('timeline capability was not checked because GitHub authentication failed.');
    }
  }

  let verdict_summary: string;
  if (!token) {
    verdict_summary = 'not ready: GITHUB_TOKEN (or GH_TOKEN) is missing.';
  } else if (authOk === false) {
    verdict_summary = 'not ready: GitHub authentication failed; the token may be invalid, expired, or revoked.';
  } else if (!cacheResult.writable) {
    verdict_summary = `not ready: cache directory (${cacheResult.evidence.dir}) is not writable.`;
  } else if (rateLimitLow) {
    verdict_summary = 'ready with caution: GitHub rate limit is low; checks may fail mid-run.';
  } else {
    verdict_summary = 'ready: token present, GitHub auth and rate limit checked, cache directory writable.';
  }

  return createEnvelope({
    verdict_summary,
    evidence,
    signals: [],
    checked: [...new Set(checked)],
    not_checked: [...new Set(not_checked)],
    cached: false
  });
}
