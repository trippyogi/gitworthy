import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitworthyError } from '../../src/core/envelope.js';
import { githubJson } from '../../src/lib/github.js';

describe('github client', () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    vi.restoreAllMocks();
  });

  it('returns a structured missing token error', async () => {
    await expect(githubJson('/repos/a/b')).rejects.toMatchObject({ code: 'missing_github_token' });
  });

  it('returns a structured rate limit error', async () => {
    process.env.GITHUB_TOKEN = 'token';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '123' } })));
    await expect(githubJson('/repos/a/b')).rejects.toBeInstanceOf(GitworthyError);
    await expect(githubJson('/repos/a/b')).rejects.toMatchObject({ code: 'github_rate_limit_exhausted' });
  });
});
