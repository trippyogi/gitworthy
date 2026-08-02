/**
 * Deterministic offline microbenchmarks for GW-029.
 * Uses frozen provider replay — no live network.
 */
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProviderReplay, withIsolatedCacheDirs } from '../src/lib/provider-install.js';
import { createRunBudget, toBudgetMetrics, withRunBudget } from '../src/lib/run-budget.js';
import { worth_check } from '../src/core/worth-check.js';
import { dupe_cluster } from '../src/core/dupe-cluster.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type BenchRow = {
  id: string;
  duration_ms: number;
  github_requests: number;
  cache_hits: number;
};

async function bench(id: string, fixtureRel: string, run: () => Promise<unknown>): Promise<BenchRow> {
  const fixture = path.join(root, fixtureRel);
  return withIsolatedCacheDirs(async () => {
    process.env.GITHUB_TOKEN = 'gitworthy-replay-token';
    const install = await installProviderReplay(fixture);
    try {
      const budget = createRunBudget();
      const started = performance.now();
      await withRunBudget(budget, run);
      const duration_ms = Math.round(performance.now() - started);
      const metrics = toBudgetMetrics(budget);
      return {
        id,
        duration_ms,
        github_requests: metrics.github_requests,
        cache_hits: metrics.cache_hits
      };
    } finally {
      await install.uninstall();
    }
  });
}

async function main() {
  const rows: BenchRow[] = [];
  rows.push(await bench(
    'worth_check_skip_open_closer',
    'eval/frozen/fixtures/frozen-worth-skip-open-closer.provider.json',
    () => worth_check({ repo: 'acme/widgets', issue_number: 300 })
  ));
  rows.push(await bench(
    'dupe_cluster_smoke',
    'eval/frozen/fixtures/frozen-smoke-dupe.provider.json',
    () => dupe_cluster({ repo: 'acme/widgets', issue_number: 1 })
  ));

  // Warm-cache second pass for dupe smoke: same process TTL may still apply after clear; report cold only for gate.
  console.log(JSON.stringify({
    schema: 'gitworthy.bench.frozen.v1',
    rows,
    notes: [
      'Offline replay only — wall times are machine-local and advisory.',
      'CI should gate on github_requests stability, not absolute duration_ms.'
    ]
  }, null, 2));

  for (const row of rows) {
    if (row.github_requests <= 0) {
      throw new Error(`${row.id} recorded zero github_requests — counters not wired`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
