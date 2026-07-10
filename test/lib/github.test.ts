import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitworthyError } from '../../src/core/envelope.js';
import { githubJson } from '../../src/lib/github.js';

let originalGithubToken: string | undefined;
let originalGhToken: string | undefined;

describe('github client', () => {
  beforeEach(() => {
    originalGithubToken = process.env.GITHUB_TOKEN;
    originalGhToken = process.env.GH_TOKEN;
  });

  afterEach(() => {
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGithubToken;
    if (originalGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalGhToken;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns a structured missing token error without touching the network', async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not be called without a token');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(githubJson('/repos/a/b')).rejects.toMatchObject({ code: 'missing_github_token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a structured rate limit error', async () => {
    process.env.GITHUB_TOKEN = 'token';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '123' } })));
    await expect(githubJson('/repos/a/b')).rejects.toBeInstanceOf(GitworthyError);
    await expect(githubJson('/repos/a/b')).rejects.toMatchObject({ code: 'github_rate_limit_exhausted' });
  });

  it('includes GitHub message details in API errors', async () => {
    process.env.GITHUB_TOKEN = 'token';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      message: 'Validation Failed',
      documentation_url: 'https://docs.github.com/rest/search/search'
    }), { status: 422, headers: { 'content-type': 'application/json' } })));
    await expect(githubJson('/search/issues?q=repo:x/y')).rejects.toMatchObject({
      code: 'github_api_error',
      status: 422,
      github_message: 'Validation Failed',
      documentation_url: 'https://docs.github.com/rest/search/search',
      message: expect.stringContaining('with status 422: Validation Failed')
    });
  });
});
