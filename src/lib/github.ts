import { GitworthyError } from '../core/envelope.js';

export type GithubIssue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  comments: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: { url?: string; html_url?: string; merged_at?: string | null };
};

export function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

const DEFAULT_GITHUB_CACHE_MS = 30_000;

// Keyed by the request path (including query string) as passed to githubJson.
// Only GET requests are coalesced/cached; mutations always bypass both maps.
const githubInFlight = new Map<string, Promise<unknown>>();
const githubTtlCache = new Map<string, { value: unknown; expiresAt: number }>();

function githubCacheTtlMs(): number {
  const raw = process.env.GITWORTHY_GITHUB_CACHE_MS;
  if (raw === undefined || raw === '') return DEFAULT_GITHUB_CACHE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_GITHUB_CACHE_MS;
}

function isGetRequest(init: RequestInit): boolean {
  return (init.method ?? 'GET').toUpperCase() === 'GET';
}

/** Clears the in-flight singleflight map and the TTL cache. For tests only. */
export function clearGithubCachesForTests(): void {
  githubInFlight.clear();
  githubTtlCache.clear();
}

export async function githubJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isGetRequest(init)) {
    return githubJsonUncached<T>(path, init);
  }
  const ttlMs = githubCacheTtlMs();
  if (ttlMs > 0) {
    const cached = githubTtlCache.get(path);
    if (cached) {
      if (cached.expiresAt > Date.now()) return cached.value as T;
      githubTtlCache.delete(path);
    }
  }
  const inFlight = githubInFlight.get(path);
  if (inFlight) return inFlight as Promise<T>;
  const promise = githubJsonUncached<T>(path, init)
    .then((value) => {
      if (ttlMs > 0) githubTtlCache.set(path, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      githubInFlight.delete(path);
    });
  githubInFlight.set(path, promise);
  return promise;
}

async function githubJsonUncached<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = githubToken();
  if (!token) {
    throw new GitworthyError({
      code: 'missing_github_token',
      message: 'GITHUB_TOKEN is required for this GitHub API check.',
      not_checked: ['GitHub API request was not checked because GITHUB_TOKEN is missing.']
    });
  }
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'gitworthy',
      ...init.headers
    }
  });
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (response.status === 403 && remaining === '0') {
      throw new GitworthyError({
        code: 'github_rate_limit_exhausted',
        message: `GitHub API rate limit exhausted. Reset epoch: ${reset ?? 'unknown'}.`,
        status: response.status,
        not_checked: ['GitHub API request was not checked because the rate limit was exhausted.']
      });
    }
    let github_message: string | undefined;
    let documentation_url: string | undefined;
    try {
      const body = await response.json() as { message?: unknown; documentation_url?: unknown };
      if (typeof body.message === 'string') github_message = body.message;
      if (typeof body.documentation_url === 'string') documentation_url = body.documentation_url;
    } catch {
      // non-JSON error bodies still produce a status-only message
    }
    const detail = github_message ? `: ${github_message}` : '.';
    throw new GitworthyError({
      code: 'github_api_error',
      message: `GitHub API request failed for ${url} with status ${response.status}${detail}`,
      status: response.status,
      github_message,
      documentation_url,
      not_checked: [`GitHub API request failed for ${url}.`]
    });
  }
  return response.json() as Promise<T>;
}

export async function fetchRaw(repo: string, branch: string, filePath: string): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${filePath}`;
  const token = githubToken();
  const response = await fetch(url, { headers: { 'user-agent': 'gitworthy', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new GitworthyError({
      code: 'raw_fetch_error',
      message: `Raw GitHub fetch failed with status ${response.status}.`,
      status: response.status,
      not_checked: [`Raw file was not checked at ${url}.`]
    });
  }
  return response.text();
}
