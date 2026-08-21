import { describe, expect, it } from 'vitest';
import { classifyCi } from '../src/core/ci-triage.js';
import { history_scan } from '../src/core/history-scan.js';
import { ingest_eval_anomaly } from '../src/core/eval-anomaly.js';
import { extractPlatformHints } from '../src/core/contribution-profile.js';

describe('GW-050a ci-triage', () => {
  it('classifies honest head/base/shared/flaky/unknown only', () => {
    expect(classifyCi({
      head: [{ name: 'test', conclusion: 'failure' }],
      base: [{ name: 'test', conclusion: 'success' }]
    }).class).toBe('head_only_failure');
    expect(classifyCi({
      head: [{ name: 'test', conclusion: 'success' }],
      base: [{ name: 'test', conclusion: 'failure' }]
    }).class).toBe('base_failure');
    expect(classifyCi({
      head: [{ name: 'test', conclusion: 'failure' }],
      base: [{ name: 'test', conclusion: 'failure' }]
    }).class).toBe('shared_failure');
    expect(classifyCi({
      head: [
        { name: 'test', conclusion: 'failure', attempt: 1 },
        { name: 'test', conclusion: 'success', attempt: 2 }
      ],
      base: [{ name: 'test', conclusion: 'success' }]
    }).class).toBe('flaky_suspected');
    expect(classifyCi({
      head: [{ name: 'test', conclusion: 'failure' }]
    }).class).toBe('unknown');
    expect(JSON.stringify(classifyCi({
      head: [{ name: 'test', conclusion: 'failure' }],
      base: [{ name: 'test', conclusion: 'success' }]
    }))).not.toMatch(/stale_fixture/i);
  });
});

describe('GW-050b history-scan', () => {
  it('refuses to run without caller-supplied query terms', async () => {
    await expect(history_scan({ repo: 'o/r' })).rejects.toMatchObject({
      code: 'history_scan_requires_query'
    });
  });

  it('returns bounded hits when a query is supplied', async () => {
    const result = await history_scan({ repo: 'o/r', paths: ['src/core/hunt.ts'] }, {
      log: async () => [{ sha: 'abc', subject: 'fix hunt', paths: ['src/core/hunt.ts'] }]
    });
    expect(result.hits).toHaveLength(1);
    expect(result.checked.join(' ')).toMatch(/bounded/);
  });
});

describe('GW-050c platform hints', () => {
  it('already extracts the five supported platforms from 045', () => {
    expect(extractPlatformHints({ title: 'fails on Windows and WSL in Docker' })).toEqual(
      expect.arrayContaining(['windows', 'wsl', 'container'])
    );
  });
});

describe('GW-050d eval anomaly ingest', () => {
  it('creates an eval_anomaly opportunity from caller-supplied identity', () => {
    const result = ingest_eval_anomaly({
      external_id: 'case-9',
      source: 'hermes-eval',
      repo: 'nous/hermes-agent',
      title: 'tool schema drift'
    });
    expect(result.target).toEqual({
      kind: 'eval_anomaly',
      external_id: 'case-9',
      source: 'hermes-eval',
      repo: 'nous/hermes-agent'
    });
  });
});
