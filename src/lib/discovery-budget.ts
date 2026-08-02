/** Discovery budgets, filter counters, and shortlist backfill (GW-025). */

export type DiscoveryBudget = {
  maxPages: number;
  maxRowsConsidered: number;
  maxRequests: number;
  deadlineMs: number;
  startedAt: number;
  pagesFetched: number;
  rowsConsidered: number;
  requestsUsed: number;
  truncated: boolean;
  truncateReasons: string[];
};

export type FilterCounts = {
  pr_row: number;
  label_mismatch: number;
  keyword_mismatch: number;
  since_mismatch: number;
  assigned: number;
  land_only: number;
  soft_ask: number;
  policy_blocked: number;
  other: number;
};

export type DiscoveryMeta = {
  discovery_version: 1;
  pages_fetched: number;
  rows_considered: number;
  requests_used: number;
  truncated: boolean;
  truncate_reasons: string[];
  filter_counts: FilterCounts;
  shortlist_backfilled: number;
  partial: boolean;
  partial_reason?: string;
};

export const DEFAULT_DISCOVERY_MAX_PAGES = 1;
export const DEFAULT_DISCOVERY_MAX_ROWS = 100;
export const DEFAULT_DISCOVERY_MAX_REQUESTS = 20;
export const DEFAULT_DISCOVERY_DEADLINE_MS = 30_000;

export function createDiscoveryBudget(overrides: Partial<{
  maxPages: number;
  maxRowsConsidered: number;
  maxRequests: number;
  deadlineMs: number;
}> = {}): DiscoveryBudget {
  return {
    maxPages: overrides.maxPages ?? DEFAULT_DISCOVERY_MAX_PAGES,
    maxRowsConsidered: overrides.maxRowsConsidered ?? DEFAULT_DISCOVERY_MAX_ROWS,
    maxRequests: overrides.maxRequests ?? DEFAULT_DISCOVERY_MAX_REQUESTS,
    deadlineMs: overrides.deadlineMs ?? DEFAULT_DISCOVERY_DEADLINE_MS,
    startedAt: Date.now(),
    pagesFetched: 0,
    rowsConsidered: 0,
    requestsUsed: 0,
    truncated: false,
    truncateReasons: []
  };
}

export function emptyFilterCounts(): FilterCounts {
  return {
    pr_row: 0,
    label_mismatch: 0,
    keyword_mismatch: 0,
    since_mismatch: 0,
    assigned: 0,
    land_only: 0,
    soft_ask: 0,
    policy_blocked: 0,
    other: 0
  };
}

export function discoveryCanFetchPage(budget: DiscoveryBudget): boolean {
  if (budget.pagesFetched >= budget.maxPages) {
    markTruncated(budget, `page cap ${budget.maxPages}`);
    return false;
  }
  if (budget.requestsUsed >= budget.maxRequests) {
    markTruncated(budget, `request cap ${budget.maxRequests}`);
    return false;
  }
  if (Date.now() - budget.startedAt >= budget.deadlineMs) {
    markTruncated(budget, `deadline ${budget.deadlineMs}ms`);
    return false;
  }
  return true;
}

export function discoveryNoteRequest(budget: DiscoveryBudget): void {
  budget.requestsUsed += 1;
}

export function discoveryNotePage(budget: DiscoveryBudget, rowCount: number): void {
  budget.pagesFetched += 1;
  budget.rowsConsidered += rowCount;
  if (budget.rowsConsidered >= budget.maxRowsConsidered) {
    markTruncated(budget, `row cap ${budget.maxRowsConsidered}`);
  }
}

function markTruncated(budget: DiscoveryBudget, reason: string): void {
  budget.truncated = true;
  if (!budget.truncateReasons.includes(reason)) budget.truncateReasons.push(reason);
}

export function toDiscoveryMeta(input: {
  budget: DiscoveryBudget;
  filterCounts: FilterCounts;
  shortlistBackfilled: number;
  partial?: boolean;
  partialReason?: string;
}): DiscoveryMeta {
  return {
    discovery_version: 1,
    pages_fetched: input.budget.pagesFetched,
    rows_considered: input.budget.rowsConsidered,
    requests_used: input.budget.requestsUsed,
    truncated: input.budget.truncated,
    truncate_reasons: [...input.budget.truncateReasons],
    filter_counts: { ...input.filterCounts },
    shortlist_backfilled: input.shortlistBackfilled,
    partial: input.partial === true,
    ...(input.partialReason ? { partial_reason: input.partialReason } : {})
  };
}

/**
 * Prefer eligible candidates for the shortlist; backfill from the ranked pool when
 * early rows are land-only / assigned / soft-ask (still keep them if the pool is thin).
 */
export function shortlistWithBackfill<T extends {
  assignees: string[];
  likely_land_only?: boolean;
  soft_ask: boolean;
}>(ranked: T[], limit: number): { selected: T[]; backfilled: number } {
  const eligible = ranked.filter((item) => item.assignees.length === 0 && item.likely_land_only !== true && item.soft_ask !== true);
  const selected: T[] = [];
  let backfilled = 0;
  for (const item of eligible) {
    if (selected.length >= limit) break;
    selected.push(item);
  }
  if (selected.length < limit) {
    for (const item of ranked) {
      if (selected.length >= limit) break;
      if (selected.includes(item)) continue;
      selected.push(item);
      backfilled += 1;
    }
  }
  // Preserve relative rank order among selected.
  selected.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
  return { selected, backfilled };
}
