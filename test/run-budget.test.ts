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
