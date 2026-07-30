import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpClient,
  createRequestBudget,
  HttpClientError,
  redactHeaders
} from '../../src/lib/http-client.js';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers }
  });
}

describe('http-client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('times out when the transport never resolves', async () => {
    const transport = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    const client = createHttpClient({
      transport,
      timeoutMs: 20,
      maxRetries: 0,
      sleep: async () => undefined
    });

    await expect(client.request('https://api.github.com/rate_limit')).rejects.toMatchObject({
      code: 'http_timeout'
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and respects Retry-After', async () => {
    const sleep = vi.fn(async () => undefined);
    const transport = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, {
        status: 429,
        headers: { 'retry-after': '2', 'x-ratelimit-remaining': '10' }
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, { status: 200 }));

    const client = createHttpClient({
      transport,
      maxRetries: 2,
      sleep,
      random: () => 0
    });

    const result = await client.request('https://api.github.com/repos/a/b');
    expect(result.response.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(result.rateLimit.remaining).toBeNull();
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not retry authentication errors (401)', async () => {
    const sleep = vi.fn(async () => undefined);
    const transport = vi.fn(async () => jsonResponse({ message: 'Bad credentials' }, { status: 401 }));
    const client = createHttpClient({
      transport,
      maxRetries: 2,
      sleep
    });

    const result = await client.request('https://api.github.com/user');
    expect(result.response.status).toBe(401);
    expect(result.attempts).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws when the request budget is exceeded', async () => {
    const budget = createRequestBudget(1);
    const transport = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createHttpClient({
      transport,
      budget,
      maxRetries: 0,
      sleep: async () => undefined
    });

    await client.request('https://api.github.com/rate_limit');
    await expect(client.request('https://api.github.com/user')).rejects.toBeInstanceOf(HttpClientError);
    await expect(client.request('https://api.github.com/user')).rejects.toMatchObject({
      code: 'http_budget_exceeded'
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(budget.usedRequests).toBe(1);
  });

  it('redacts authorization headers in log metadata', () => {
    expect(redactHeaders({
      authorization: 'Bearer secret-token',
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    })).toEqual({
      authorization: '[redacted]',
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    });
  });

  it('does not retry non-idempotent methods on transient 503', async () => {
    const sleep = vi.fn(async () => undefined);
    const transport = vi.fn(async () => jsonResponse({ message: 'unavailable' }, { status: 503 }));
    const client = createHttpClient({
      transport,
      maxRetries: 2,
      sleep
    });

    const result = await client.request('https://api.github.com/repos/a/b/issues', { method: 'POST', body: '{}' });
    expect(result.response.status).toBe(503);
    expect(result.attempts).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
