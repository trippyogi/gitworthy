import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureManifestSchema, type CaptureManifest } from '../src/contracts/capture.js';
import { createHttpClient, redactHeaders, redactUrl } from '../src/lib/http-client.js';
import { scrubJsonSecrets, scrubSecretText } from '../src/lib/redaction.js';
import { withCaptureSession } from '../src/lib/capture-session.js';
import { putCaptureManifest, promoteCapture, captureBundleDir, captureManifestPath } from '../src/lib/capture-store.js';
import { captureTargetForRepoIssue } from '../src/lib/capture-policy.js';
import { clearGithubCachesForTests, configureGithubHttpForTests } from '../src/lib/github.js';
import { capture_show, case_promote } from '../src/core/capture-commands.js';

function publicManifest(id = 'capture_test1'): CaptureManifest {
  return CaptureManifestSchema.parse({
    record_version: 1,
    record_kind: 'capture',
    capture_id: id,
    created_at: '2026-08-02T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
    gitworthy_version: '0.0.0-test',
    run_id: 'run_test1',
    decision_id: 'decision_test1',
    decision_ids: ['decision_test1'],
    command: 'check',
    target: {
      kind: 'repo_issue',
      input: 'o/r',
      canonical: 'o/r',
      issue_number: 1,
      html_url: 'https://github.com/o/r/issues/1',
      is_private: false
    },
    source: {
      surface: 'test',
      requested_at: '2026-08-02T00:00:00.000Z',
      attribution: 'unit test'
    },
    capture_mode: 'public',
    promotable: true,
    exchanges: [{
      sequence: 0,
      captured_at: '2026-08-02T00:00:00.000Z',
      provider: 'github',
      method: 'GET',
      canonical_url: 'https://api.github.com/repos/o/r/issues/1',
      status: 200,
      request_headers: { authorization: '[redacted]' },
      response_headers: { 'content-type': 'application/json' },
      request_body_digest_sha256: null,
      body_digest_sha256: 'abc',
      response_fields: { number: 1, title: 'bug' }
    }],
    errors: []
  });
}

describe('capture redaction and manifests (GW-018)', () => {
  let dir: string;
  let previousStore: string | undefined;
  let previousToken: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-capture-'));
    previousStore = process.env.GITWORTHY_STORE_DIR;
    previousToken = process.env.GITHUB_TOKEN;
    process.env.GITWORTHY_STORE_DIR = dir;
    process.env.GITHUB_TOKEN = 'test-token';
    clearGithubCachesForTests();
  });

  afterEach(async () => {
    if (previousStore === undefined) delete process.env.GITWORTHY_STORE_DIR;
    else process.env.GITWORTHY_STORE_DIR = previousStore;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    clearGithubCachesForTests();
    configureGithubHttpForTests(null);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('redacts tokens, cookies, request ids, and token-like body text', () => {
    expect(redactHeaders({
      authorization: 'Bearer secret',
      cookie: 'sid=secret',
      'x-access-token': 'opaque-access-token',
      'x-github-request-id': 'ABC:123',
      accept: 'application/json'
    })).toEqual({
      authorization: '[redacted]',
      cookie: '[redacted]',
      'x-access-token': '[redacted]',
      'x-github-request-id': '[redacted]',
      accept: 'application/json'
    });
    expect(redactUrl('https://user:pass@example.test/path?b=2&access_token=secret&x-access-token=abc&request_id=abc')).toBe('https://%5Bredacted%5D:%5Bredacted%5D@example.test/path?access_token=%5Bredacted%5D&b=2&request_id=%5Bredacted%5D&x-access-token=%5Bredacted%5D');
    const scrubbed = scrubSecretText('Authorization: token abcdefghijklmnopqrstuvwxyz token=secret x-access-token=opaque npm_abcdefghijklmnopqrstuvwxyz request_id=req-1 Cookie: sid=secret');
    expect(scrubbed).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(scrubbed).not.toContain('secret');
    expect(scrubbed).not.toContain('opaque');
    expect(scrubbed).not.toContain('npm_');
    expect(scrubbed).not.toContain('req-1');
    expect(scrubJsonSecrets({
      private_key: 'pem',
      api_key: 'api',
      nested: { keep: 'ok' }
    })).toEqual({
      private_key: '[redacted]',
      api_key: '[redacted]',
      nested: { keep: 'ok' }
    });
  });

  it('captures minimal redacted response fields through the HTTP boundary', async () => {
    const client = createHttpClient({
      maxRetries: 0,
      transport: async () => new Response(JSON.stringify({
        number: 1,
        title: 'issue',
        token: 'test-token-value',
        nested: { cookie: 'sid=secret', kept: 'ok' }
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-github-request-id': 'REQ' } })
    });
    const captured = await withCaptureSession({
      command: 'check',
      capture_mode: 'public',
      target: {
        kind: 'repo_issue',
        input: 'o/r',
        canonical: 'o/r',
        issue_number: 1,
        html_url: 'https://github.com/o/r/issues/1',
        is_private: false
      },
      source: { surface: 'test', attribution: 'unit test' }
    }, async () => {
      await client.request('https://api.github.com/repos/o/r/issues/1?token=secret');
      return 'ok';
    });
    const exchange = captured.manifest.exchanges[0];
    expect(exchange.canonical_url).toContain('token=%5Bredacted%5D');
    expect(exchange.response_headers['x-github-request-id']).toBe('[redacted]');
    expect(exchange.body_digest_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(exchange.response_fields).toMatchObject({
      number: 1,
      title: 'issue',
      token: '[redacted]',
      nested: { cookie: '[redacted]', kept: 'ok' }
    });
  });

  it('enforces public/private capture policy and local-only non-promotion', async () => {
    configureGithubHttpForTests({
      maxRetries: 0,
      transport: async () => new Response(JSON.stringify({
        full_name: 'o/private',
        html_url: 'https://github.com/o/private',
        private: true
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    });
    await expect(captureTargetForRepoIssue({ repo: 'o/private', issue_number: 1, capture_mode: 'public' }))
      .rejects.toMatchObject({ code: 'capture_private_repo_rejected' });
    const target = await captureTargetForRepoIssue({ repo: 'o/private', issue_number: 1, capture_mode: 'local_only' });
    expect(target.is_private).toBe(true);
    const manifest = CaptureManifestSchema.parse({
      ...publicManifest('capture_private_local'),
      target,
      capture_mode: 'local_only',
      promotable: false
    });
    expect(manifest.promotable).toBe(false);
  });

  it('validates stable capture manifest schema', () => {
    const manifest = publicManifest();
    expect(manifest.schema_version).toBe('1.0-draft.1');
    expect(manifest.record_version).toBe(1);
    expect(manifest.exchanges[0].response_fields).toEqual({ number: 1, title: 'bug' });
  });

  it('requires adjudication, writes deterministic promotion output, and refuses silent overwrite', async () => {
    const manifest = await putCaptureManifest(publicManifest('capture_promote'));
    const mode = (await stat(captureManifestPath(manifest.capture_id))).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
    const outPath = path.join(dir, 'case.json');
    await expect(case_promote({
      capture_id: manifest.capture_id,
      verdict: 'ACT',
      disposition: 'greenfield',
      adjudicator_rationale: '',
      evidence_urls: ['https://github.com/o/r/issues/1'],
      out_path: outPath
    })).rejects.toMatchObject({ code: 'case_promote_requires_rationale' });
    const first = await promoteCapture({
      capture_id: manifest.capture_id,
      verdict: 'ACT',
      disposition: 'greenfield',
      adjudicator_rationale: 'Reviewed linked work and issue state.',
      evidence_urls: ['https://github.com/o/r/issues/1'],
      out_path: outPath
    });
    const firstBytes = await readFile(outPath, 'utf8');
    await expect(promoteCapture({
      capture_id: manifest.capture_id,
      verdict: 'ACT',
      disposition: 'greenfield',
      adjudicator_rationale: 'Reviewed linked work and issue state.',
      evidence_urls: ['https://github.com/o/r/issues/1'],
      out_path: outPath
    })).rejects.toMatchObject({ code: 'case_promote_output_exists' });
    await promoteCapture({
      capture_id: manifest.capture_id,
      verdict: 'ACT',
      disposition: 'greenfield',
      adjudicator_rationale: 'Reviewed linked work and issue state.',
      evidence_urls: ['https://github.com/o/r/issues/1'],
      out_path: outPath,
      force: true
    });
    expect(await readFile(outPath, 'utf8')).toBe(firstBytes);
    expect(first.fixture.source.capture_id).toBe(manifest.capture_id);
  });

  it('rejects forged private/local-only promotion eligibility', async () => {
    const forgedPrivate = {
      ...publicManifest('capture_forged_private'),
      target: { ...publicManifest('capture_forged_private').target, is_private: true },
      promotable: true
    };
    expect(CaptureManifestSchema.safeParse(forgedPrivate).success).toBe(false);
    const bundle = captureBundleDir('capture_forged_private');
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, 'manifest.json'), `${JSON.stringify(forgedPrivate, null, 2)}\n`, 'utf8');
    await expect(promoteCapture({
      capture_id: 'capture_forged_private',
      verdict: 'ACT',
      disposition: 'greenfield',
      adjudicator_rationale: 'reviewed',
      evidence_urls: ['https://github.com/o/r/issues/1'],
      out_path: path.join(dir, 'forged.json')
    })).rejects.toMatchObject({ code: 'capture_malformed' });

    const localOnly = await putCaptureManifest({
      ...publicManifest('capture_local_only'),
      capture_mode: 'local_only',
      promotable: false
    });
    await expect(promoteCapture({
      capture_id: localOnly.capture_id,
      verdict: 'ACT',
      disposition: 'greenfield',
      adjudicator_rationale: 'reviewed',
      evidence_urls: ['https://github.com/o/r/issues/1'],
      out_path: path.join(dir, 'local.json')
    })).rejects.toMatchObject({ code: 'capture_not_promotable' });

    const unknownVisibility = await putCaptureManifest({
      ...publicManifest('capture_unknown_visibility'),
      target: { ...publicManifest('capture_unknown_visibility').target, is_private: null },
      promotable: false
    });
    await expect(promoteCapture({
      capture_id: unknownVisibility.capture_id,
      verdict: 'ACT',
      disposition: 'greenfield',
      adjudicator_rationale: 'reviewed',
      evidence_urls: ['https://github.com/o/r/issues/1'],
      out_path: path.join(dir, 'unknown.json')
    })).rejects.toMatchObject({ code: 'capture_not_promotable' });
  });

  it('rejects capture ids that could traverse or collide with reserved directories', async () => {
    for (const id of ['.', '..', '../escape', 'nested/id', 'nested\\id', 'quarantine', 'bad id']) {
      expect(() => captureBundleDir(id)).toThrow(expect.objectContaining({ code: 'invalid_capture_id' }));
    }
    await expect(capture_show({ capture_id: '../escape' })).rejects.toMatchObject({ code: 'invalid_capture_id' });
  });

  it('rejects and quarantines malformed captures', async () => {
    const bundle = captureBundleDir('capture_bad');
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, 'manifest.json'), '{"record_kind":"not_capture"}\n', 'utf8');
    await expect(capture_show({ capture_id: 'capture_bad' })).rejects.toMatchObject({ code: 'capture_malformed' });
    await expect(readFile(path.join(bundle, 'manifest.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
