import { describe, expect, it, vi } from 'vitest';
import { createTelemetryClient } from '../src/cli/telemetry.js';
import { worth_check } from '../src/core/worth-check.js';

vi.mock('../src/lib/git.js', () => ({
  lsRemoteHeads: vi.fn(async () => []),
  shallowClone: vi.fn(async () => ({ dir: process.cwd(), cleanup: async () => undefined }))
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: vi.fn(async () => ({ number: 1, title: 'Add fastapi example', body: 'example-apps/fastapi', state: 'open', labels: [], comments: 0, html_url: 'https://github.com/o/r/issues/1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null })),
  fetchRaw: vi.fn(async () => null)
}));

describe('telemetry', () => {
  it('does not call non-allowlisted network destinations when flags are unset', async () => {
    delete process.env.GITWORTHY_TELEMETRY;
    delete process.env.GITWORTHY_POSTHOG_KEY;
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = await createTelemetryClient();
    client.capture({ event: 'test' });
    await worth_check({ repo: 'o/r', issue_number: 1 });
    await client.shutdown();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => url.startsWith('https://api.github.com') || url.startsWith('https://raw.githubusercontent.com') || url.startsWith('https://registry.npmjs.org'))).toBe(true);
    expect(urls.some((url) => url.includes('posthog'))).toBe(false);
  });
});
