import { readFile, writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvalCaseSchema, EvalCaseCatalogSchema } from '../src/contracts/eval.js';
import { ProviderFixturePackSchema, FORBIDDEN_FIXTURE_HEADER_NAMES } from '../src/contracts/provider-fixtures.js';
import { dupe_cluster } from '../src/core/dupe-cluster.js';
import { clearGithubCachesForTests } from '../src/lib/github.js';
import { installProviderReplay, withIsolatedCacheDirs } from '../src/lib/provider-install.js';
import {
  captureExchangesToProviderPack,
  createHttpReplaySession,
  ProviderReplayError
} from '../src/lib/provider-replay.js';
import { normalizeRequestUrl, httpMatchKey } from '../src/lib/url-normalize.js';
import { configureGitEvalHooks, lsRemoteHeads, resetGitCachesForTests } from '../src/lib/git.js';
import { createGitReplaySession } from '../src/lib/git-replay.js';

const frozenCasePath = path.join(process.cwd(), 'eval', 'frozen', 'cases', 'frozen-smoke-dupe.json');
const frozenFixturePath = path.join(process.cwd(), 'eval', 'frozen', 'fixtures', 'frozen-smoke-dupe.provider.json');
const liveCatalogPath = path.join(process.cwd(), 'eval', 'live', 'cases.json');

describe('eval suite contracts (GW-021)', () => {
  it('accepts the frozen smoke case and live catalog', async () => {
    const frozen = EvalCaseSchema.parse(JSON.parse(await readFile(frozenCasePath, 'utf8')));
    expect(frozen.suite).toBe('frozen');
    expect(frozen.ground_truth?.failure_mode).toBeTruthy();
    const catalog = EvalCaseCatalogSchema.parse(JSON.parse(await readFile(liveCatalogPath, 'utf8')));
    expect(catalog.suite).toBe('live');
    expect(catalog.cases.length).toBeGreaterThanOrEqual(12);
    expect(catalog.cases.every((item) => item.classification !== 'frozen')).toBe(true);
  });

  it('rejects private cases marked classification=frozen', () => {
    expect(() => EvalCaseSchema.parse({
      case_version: 1,
      id: 'private-bad',
      suite: 'private',
      name: 'bad',
      function: 'dupe_cluster',
      input: { repo: 'a/b', issue_number: 1 },
      classification: 'frozen',
      provider_fixtures: './x.json'
    })).toThrow(/cannot be classification=frozen/i);
  });

  it('keeps eval/private gitignored', async () => {
    const gitignore = await readFile(path.join(process.cwd(), '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/eval\/private\//);
    expect(gitignore).toMatch(/eval\/reports\//);
  });
});

describe('provider replay transport (GW-022)', () => {
  afterEach(async () => {
    clearGithubCachesForTests();
    configureGitEvalHooks(null);
    await resetGitCachesForTests();
  });

  it('normalizes URLs deterministically for matching', () => {
    const a = normalizeRequestUrl('https://api.github.com/search/issues?q=repo%3Aa%2Fb+is%3Aissue+x&per_page=50');
    const b = normalizeRequestUrl('https://api.github.com/search/issues?per_page=50&q=repo:a/b is:issue x');
    expect(a).toBe(b);
    expect(httpMatchKey({ method: 'get', canonical_url: a })).toContain('GET');
  });

  it('replays ordered identical endpoint calls and flags unused fixtures', async () => {
    const pack = ProviderFixturePackSchema.parse({
      fixture_version: 1,
      case_id: 'ordered',
      http_exchanges: [
        {
          sequence: 0,
          provider: 'github',
          match: { method: 'GET', canonical_url: 'https://api.github.com/repos/a/b', request_body_digest_sha256: null },
          response: { status: 200, body_encoding: 'json', body: { n: 1 }, headers: {} }
        },
        {
          sequence: 1,
          provider: 'github',
          match: { method: 'GET', canonical_url: 'https://api.github.com/repos/a/b', request_body_digest_sha256: null },
          response: { status: 200, body_encoding: 'json', body: { n: 2 }, headers: {} }
        }
      ],
      git_probes: []
    });
    const session = createHttpReplaySession(pack);
    const first = await session.transport('https://api.github.com/repos/a/b', { method: 'GET' });
    const second = await session.transport('https://api.github.com/repos/a/b', { method: 'GET' });
    expect(await first.json()).toEqual({ n: 1 });
    expect(await second.json()).toEqual({ n: 2 });
    session.assertExhausted();
  });

  it('throws on unexpected requests and unused fixtures', async () => {
    const pack = ProviderFixturePackSchema.parse({
      fixture_version: 1,
      case_id: 'miss',
      http_exchanges: [{
        sequence: 0,
        provider: 'npm',
        match: { method: 'GET', canonical_url: 'https://registry.npmjs.org/demo', request_body_digest_sha256: null },
        response: { status: 200, body_encoding: 'json', body: { name: 'demo' }, headers: {} }
      }],
      git_probes: []
    });
    const session = createHttpReplaySession(pack);
    await expect(session.transport('https://api.github.com/repos/a/b', { method: 'GET' }))
      .rejects.toMatchObject({ code: 'replay_unexpected_request' });
    expect(() => session.assertExhausted()).toThrow(ProviderReplayError);
  });

  it('rejects secret-bearing fixture headers structurally', () => {
    for (const header of FORBIDDEN_FIXTURE_HEADER_NAMES) {
      expect(() => ProviderFixturePackSchema.parse({
        fixture_version: 1,
        case_id: 'secret',
        http_exchanges: [{
          sequence: 0,
          provider: 'github',
          match: { method: 'GET', canonical_url: 'https://api.github.com/repos/a/b', request_body_digest_sha256: null },
          response: { status: 200, body_encoding: 'json', body: {}, headers: { [header]: 'secret' } }
        }],
        git_probes: []
      })).toThrow(/disallowed|credential/i);
    }
  });

  it('converts capture exchanges to provider packs deterministically', () => {
    const first = captureExchangesToProviderPack({
      case_id: 'from-capture',
      exchanges: [{
        sequence: 0,
        provider: 'github',
        method: 'GET',
        canonical_url: 'https://api.github.com/repos/a/b?b=1&a=2',
        status: 200,
        response_headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
        response_fields: { ok: true }
      }]
    });
    const second = captureExchangesToProviderPack({
      case_id: 'from-capture',
      exchanges: [{
        sequence: 0,
        provider: 'github',
        method: 'GET',
        canonical_url: 'https://api.github.com/repos/a/b?b=1&a=2',
        status: 200,
        response_headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
        response_fields: { ok: true }
      }]
    });
    expect(first).toEqual(second);
    expect(first.http_exchanges[0]?.response.headers.authorization).toBeUndefined();
    expect(first.http_exchanges[0]?.match.canonical_url).toContain('a=2');
  });

  it('replays git ls-remote fixtures without network', async () => {
    const pack = ProviderFixturePackSchema.parse({
      fixture_version: 1,
      case_id: 'git-heads',
      http_exchanges: [],
      git_probes: [{
        sequence: 0,
        kind: 'ls_remote_heads',
        match: { repo: 'acme/widgets' },
        response: { heads: [{ name: 'main', sha: 'abc123' }] }
      }]
    });
    const session = createGitReplaySession(pack);
    configureGitEvalHooks(session.hooks);
    await expect(lsRemoteHeads('acme/widgets')).resolves.toEqual([{ name: 'main', sha: 'abc123' }]);
    session.assertExhausted();
    await session.cleanup();
  });

  it('runs frozen smoke dupe_cluster offline twice with identical outcomes', async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'gitworthy-replay-token';
    const runOnce = async () => withIsolatedCacheDirs(async () => {
      const install = await installProviderReplay(frozenFixturePath);
      try {
        const result = await dupe_cluster({ repo: 'acme/widgets', issue_number: 1 });
        install.assertExhausted();
        return result;
      } finally {
        await install.uninstall();
      }
    });

    try {
      const first = await runOnce();
      const second = await runOnce();
      expect(first.signals).toContain('duplicate');
      expect(second.signals).toEqual(first.signals);
      expect(JSON.stringify(second.evidence)).toBe(JSON.stringify(first.evidence));
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it('simulates provider timeout fixtures', async () => {
    const pack = ProviderFixturePackSchema.parse({
      fixture_version: 1,
      case_id: 'timeout',
      http_exchanges: [{
        sequence: 0,
        provider: 'github',
        match: { method: 'GET', canonical_url: 'https://api.github.com/rate_limit', request_body_digest_sha256: null },
        response: { error: 'timeout', body_encoding: 'omitted', headers: {} }
      }],
      git_probes: []
    });
    const session = createHttpReplaySession(pack);
    await expect(session.transport('https://api.github.com/rate_limit', { method: 'GET' }))
      .rejects.toMatchObject({ code: 'http_timeout' });
  });
});

describe('private promotion boundary (GW-021)', () => {
  it('does not treat gitignored private JSON as frozen corpus input', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-private-suite-'));
    try {
      await mkdir(path.join(dir, 'private'), { recursive: true });
      await writeFile(path.join(dir, 'private', 'sneaky.json'), JSON.stringify({
        case_version: 1,
        id: 'sneaky',
        suite: 'private',
        name: 'sneaky',
        function: 'dupe_cluster',
        input: { repo: 'a/b', issue_number: 1 },
        classification: 'frozen',
        provider_fixtures: './nope.json',
        ground_truth: {
          verdict: 'SKIP',
          disposition: 'blocked',
          failure_mode: 'should-not-load',
          adjudicator_rationale: 'x',
          evidence_urls: ['https://example.com/x']
        }
      }));
      const raw = JSON.parse(await readFile(path.join(dir, 'private', 'sneaky.json'), 'utf8'));
      expect(() => EvalCaseSchema.parse(raw)).toThrow(/cannot be classification=frozen/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
