import { GitworthyError } from '../core/envelope.js';

export type GithubIssue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  comments: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

export async function githubJson<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    throw new GitworthyError({
      code: 'github_api_error',
      message: `GitHub API request failed with status ${response.status}.`,
      status: response.status,
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
