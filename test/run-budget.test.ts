import { describe, expect, it } from 'vitest';
import {
  createRunBudget,
  mergeBudgetMetrics,
  noteCacheHit,
  noteGithubRequest,
  noteGithubRetry,
  toBudgetMetrics,
  withRunBudget
} from '../src/lib/run-budget.js';

describe('run budget counters', () => {
  it('counts github requests, retries, and cache hits inside withRunBudget', async () => {
    const budget = createRunBudget({ maxGithubRequests: 10 });
    await withRunBudget(budget, async () => {
      noteGithubRequest();
      noteGithubRequest();
      noteGithubRetry();
      noteCacheHit();
    });
    expect(toBudgetMetrics(budget)).toMatchObject({
      github_requests: 2,
      github_retries: 1,
      cache_hits: 1,
      counters_version: 1,
      budget_exhausted: false
    });
  });

  it('marks exhaustion when the github request cap is exceeded', async () => {
    const budget = createRunBudget({ maxGithubRequests: 1 });
    await withRunBudget(budget, async () => {
      noteGithubRequest();
      noteGithubRequest();
    });
    expect(budget.counters.exhausted).toBe(true);
    expect(budget.counters.exhaustion_reasons[0]).toMatch(/github request cap/);
  });

  it('merges budget metrics over existing duration_ms without wiping higher values', () => {
    const budget = createRunBudget();
    budget.counters.github_requests = 3;
    const merged = mergeBudgetMetrics({ duration_ms: 999 }, budget);
    expect(merged.github_requests).toBe(3);
    expect(merged.duration_ms).toBeGreaterThanOrEqual(999);
  });
});

describe('http client github retry accounting', () => {
  it('counts retries only for github requests', async () => {
    const { createHttpClient } = await import('../src/lib/http-client.js');
    const budget = createRunBudget();
    let calls = 0;
    const transport = async () => {
      calls += 1;
      if (calls === 1) return new Response('fail', { status: 503, headers: { 'retry-after': '0' } });
      return new Response('ok', { status: 200 });
    };
    const client = createHttpClient({ transport, sleep: async () => undefined, maxRetries: 2 });
    await withRunBudget(budget, async () => {
      await client.request('https://example.test/npm', { github: false });
    });
    expect(budget.counters.github_retries).toBe(0);

    calls = 0;
    await withRunBudget(budget, async () => {
      await client.request('https://api.github.com/rate_limit');
    });
    expect(budget.counters.github_retries).toBe(1);
  });
});
