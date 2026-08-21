import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { classifyCi, ci_triage } from '../src/core/ci-triage.js';
import { history_scan, normalizeHistoryPath } from '../src/core/history-scan.js';
import { ingest_eval_anomaly, opportunity_ingest } from '../src/core/eval-anomaly.js';
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
    expect(classifyCi({
      head: [{ name: 'test', conclusion: 'failure' }],
      base: []
    }).class).toBe('unknown');
    expect(classifyCi({
      head: [{ name: 'test', conclusion: 'failure' }],
      base: [{ name: 'lint', conclusion: 'failure' }]
    }).class).toBe('unknown');
    expect(JSON.stringify(classifyCi({
      head: [{ name: 'test', conclusion: 'failure' }],
      base: [{ name: 'test', conclusion: 'success' }]
    }))).not.toMatch(/stale_fixture/i);
    const wrapped = ci_triage({
      head: [{ name: 'test', conclusion: 'failure' }],
      base: [{ name: 'test', conclusion: 'success' }]
    });
    expect(wrapped.class).toBe('head_only_failure');
    expect(wrapped.confidence).toBe('medium');
    expect(wrapped.next_actions[0]?.message).toMatch(/failing head check/);
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

  it('rejects option-like and parent paths', () => {
    expect(normalizeHistoryPath('../secret')).toBeNull();
    expect(normalizeHistoryPath('-n')).toBeNull();
    expect(normalizeHistoryPath('C:/Windows/system32')).toBeNull();
    expect(normalizeHistoryPath('src/core/hunt.ts')).toBe('src/core/hunt.ts');
  });

  it('reads live commits from a matching local checkout', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gw-history-'));
    const previous = process.env.GITWORTHY_LOCAL_REPO;
    try {
      await execa('git', ['init'], { cwd: dir });
      await execa('git', ['config', 'user.email', 'history@gitworthy.local'], { cwd: dir });
      await execa('git', ['config', 'user.name', 'gitworthy-history'], { cwd: dir });
      await execa('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: dir });
      await writeFile(path.join(dir, 'src-foo.ts'), 'export const foo = 1;\n');
      await execa('git', ['add', 'src-foo.ts'], { cwd: dir });
      await execa('git', ['commit', '-m', 'add foo helper'], { cwd: dir });
      process.env.GITWORTHY_LOCAL_REPO = dir;
      const result = await history_scan({ repo: 'acme/demo', paths: ['src-foo.ts'], symbols: ['foo'] });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits[0]?.subject).toMatch(/foo/);
      expect(result.checked.join(' ')).toMatch(/argv-only/);
      const empty = await history_scan({ repo: 'acme/demo', paths: ['no-such-file.ts'] });
      expect(empty.hits).toEqual([]);
      expect(empty.not_checked.join(' ')).toMatch(/found no commits/);
      expect(empty.not_checked.join(' ')).not.toMatch(/No matching local checkout/);
    } finally {
      if (previous === undefined) delete process.env.GITWORTHY_LOCAL_REPO;
      else process.env.GITWORTHY_LOCAL_REPO = previous;
      await rm(dir, { recursive: true, force: true });
    }
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
    expect(opportunity_ingest({
      external_id: 'case-9',
      source: 'hermes-eval'
    }).target.kind).toBe('eval_anomaly');
  });
});
