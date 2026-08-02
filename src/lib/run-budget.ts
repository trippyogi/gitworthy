/** Run-scoped performance counters and soft budgets (GW-029). */

import { AsyncLocalStorage } from 'node:async_hooks';

export const PERF_COUNTERS_VERSION = 1 as const;

export type PerfCounters = {
  counters_version: typeof PERF_COUNTERS_VERSION;
  github_requests: number;
  github_retries: number;
  cache_hits: number;
  git_commands: number;
  bytes_read: number;
  pages_fetched: number;
  candidates_considered: number;
  started_at: number;
  exhausted: boolean;
  exhaustion_reasons: string[];
};

export type RunBudgetLimits = {
  maxGithubRequests?: number;
  maxElapsedMs?: number;
};

export type RunBudget = RunBudgetLimits & {
  counters: PerfCounters;
};

export type BudgetMetrics = {
  duration_ms: number;
  github_requests: number;
  github_retries: number;
  cache_hits: number;
  git_commands: number;
  bytes_read: number;
  pages_fetched: number;
  candidates_considered: number;
  counters_version: typeof PERF_COUNTERS_VERSION;
  budget_exhausted: boolean;
  budget_reasons: string[];
};

const storage = new AsyncLocalStorage<RunBudget>();

export function createPerfCounters(): PerfCounters {
  return {
    counters_version: PERF_COUNTERS_VERSION,
    github_requests: 0,
    github_retries: 0,
    cache_hits: 0,
    git_commands: 0,
    bytes_read: 0,
    pages_fetched: 0,
    candidates_considered: 0,
    started_at: Date.now(),
    exhausted: false,
    exhaustion_reasons: []
  };
}

export function createRunBudget(limits: RunBudgetLimits = {}): RunBudget {
  return {
    ...limits,
    counters: createPerfCounters()
  };
}

export function getActiveRunBudget(): RunBudget | undefined {
  return storage.getStore();
}

export async function withRunBudget<T>(budget: RunBudget, fn: () => Promise<T>): Promise<T> {
  return storage.run(budget, fn);
}

/** Bind a budget for the remainder of the current async context (CLI/MCP entrypoints). */
export function enterRunBudget(budget: RunBudget = createRunBudget()): RunBudget {
  storage.enterWith(budget);
  return budget;
}

export function noteGithubRequest(count = 1): void {
  const budget = storage.getStore();
  if (!budget) return;
  budget.counters.github_requests += count;
  enforceRequestCap(budget);
}

export function noteGithubRetry(count = 1): void {
  const budget = storage.getStore();
  if (!budget) return;
  budget.counters.github_retries += count;
}

export function noteCacheHit(count = 1): void {
  const budget = storage.getStore();
  if (!budget) return;
  budget.counters.cache_hits += count;
}

export function noteGitCommand(count = 1): void {
  const budget = storage.getStore();
  if (!budget) return;
  budget.counters.git_commands += count;
}

export function noteBytesRead(bytes: number): void {
  const budget = storage.getStore();
  if (!budget || !Number.isFinite(bytes) || bytes <= 0) return;
  budget.counters.bytes_read += Math.floor(bytes);
}

export function notePagesFetched(count = 1): void {
  const budget = storage.getStore();
  if (!budget) return;
  budget.counters.pages_fetched += count;
}

export function noteCandidatesConsidered(count: number): void {
  const budget = storage.getStore();
  if (!budget || !Number.isFinite(count) || count <= 0) return;
  budget.counters.candidates_considered += Math.floor(count);
}

export function markBudgetExhausted(reason: string): void {
  const budget = storage.getStore();
  if (!budget) return;
  budget.counters.exhausted = true;
  if (!budget.counters.exhaustion_reasons.includes(reason)) {
    budget.counters.exhaustion_reasons.push(reason);
  }
}

export function checkElapsedBudget(): boolean {
  const budget = storage.getStore();
  if (!budget?.maxElapsedMs) return true;
  if (Date.now() - budget.counters.started_at <= budget.maxElapsedMs) return true;
  markBudgetExhausted(`elapsed cap ${budget.maxElapsedMs}ms`);
  return false;
}

export function toBudgetMetrics(budget: RunBudget = storage.getStore() ?? createRunBudget()): BudgetMetrics {
  return {
    duration_ms: Math.max(0, Date.now() - budget.counters.started_at),
    github_requests: budget.counters.github_requests,
    github_retries: budget.counters.github_retries,
    cache_hits: budget.counters.cache_hits,
    git_commands: budget.counters.git_commands,
    bytes_read: budget.counters.bytes_read,
    pages_fetched: budget.counters.pages_fetched,
    candidates_considered: budget.counters.candidates_considered,
    counters_version: PERF_COUNTERS_VERSION,
    budget_exhausted: budget.counters.exhausted,
    budget_reasons: [...budget.counters.exhaustion_reasons]
  };
}

export function mergeBudgetMetrics(
  existing: Record<string, unknown> | undefined,
  budget?: RunBudget
): Record<string, unknown> {
  const metrics = toBudgetMetrics(budget ?? storage.getStore() ?? createRunBudget());
  const durationFromExisting = typeof existing?.duration_ms === 'number' ? existing.duration_ms : undefined;
  return {
    ...(existing ?? {}),
    ...metrics,
    ...(durationFromExisting !== undefined && durationFromExisting > metrics.duration_ms
      ? { duration_ms: durationFromExisting }
      : {})
  };
}

function enforceRequestCap(budget: RunBudget): void {
  if (typeof budget.maxGithubRequests !== 'number') return;
  if (budget.counters.github_requests <= budget.maxGithubRequests) return;
  markBudgetExhausted(`github request cap ${budget.maxGithubRequests}`);
}
