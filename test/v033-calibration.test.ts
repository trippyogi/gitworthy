import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { release_gap } from '../src/core/release-gap.js';
import { dupe_cluster } from '../src/core/dupe-cluster.js';

let cloneDir: string;
let tarballDir: string;

const githubMocks = vi.hoisted(() => ({
  githubJson: vi.fn()
}));

vi.mock('../src/lib/git.js', () => ({
  shallowClone: vi.fn(async () => ({ dir: cloneDir, cleanup: async () => undefined }))
}));

vi.mock('../src/lib/registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/registry.js')>('../src/lib/registry.js');
  return {
    ...actual,
    npmMetadata: vi.fn(async () => ({
      name: 'demo',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz' } } },
      time: { '1.0.0': '2026-07-01T00:00:00.000Z' }
    })),
    downloadAndExtractTarball: vi.fn(async () => ({ dir: tarballDir, cleanup: async () => undefined }))
  };
});

vi.mock('../src/lib/github.js', () => ({
  githubJson: githubMocks.githubJson,
  fetchRaw: vi.fn(async () => null)
}));

function issue(number: number, title: string, state = 'open', body = '', extra: Record<string, unknown> = {}) {
  return {
    number,
    title,
    body,
    state,
    labels: [],
    comments: 0,
    html_url: `https://github.com/o/r/issues/${number}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: state === 'closed' ? '2026-01-02T00:00:00Z' : null,
    ...extra
  };
}

describe('v0.3.3 calibration regressions', () => {
  beforeEach(async () => {
    cloneDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-release-clone-'));
    tarballDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-release-tarball-'));
    await writeFile(path.join(cloneDir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
    await mkdir(path.join(tarballDir, 'package', 'dist'), { recursive: true });
    await writeFile(path.join(tarballDir, 'package', 'dist', 'index.js'), 'console.log("shipped");\n');
    vi.clearAllMocks();
    githubMocks.githubJson.mockImplementation(async (requestPath: string) => {
      if (/^\/repos\/[^/]+\/[^/]+$/.test(requestPath)) {
        const full_name = requestPath.slice('/repos/'.length);
        return { full_name, default_branch: 'main', html_url: `https://github.com/${full_name}` };
      }
      if (requestPath.includes('/search/issues')) return { items: [] };
      if (requestPath.includes('/issues?')) return [];
      return issue(1, 'target');
    });
  });

  afterEach(async () => {
    await rm(cloneDir, { recursive: true, force: true });
    await rm(tarballDir, { recursive: true, force: true });
  });

  it('excludes pull requests from duplicate clusters', async () => {
    githubMocks.githubJson.mockImplementation(async (requestPath: string) => {
      if (/^\/repos\/[^/]+\/[^/]+$/.test(requestPath)) {
        return { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
      }
      if (requestPath.includes('/search/issues')) return { items: [] };
      if (requestPath.includes('/issues?')) {
        return [issue(1675, 'Iframe sandbox fails to load app preview', 'closed', 'agent domain workspace configuration iframe issue same problem', {
          pull_request: { url: 'https://api.github.com/repos/o/r/pulls/1675' }
        })];
      }
      if (requestPath.includes('/issues/1659')) {
        return issue(1659, 'Iframe sandbox fails to load app preview', 'open', 'agent domain workspace configuration iframe issue same problem');
      }
      return issue(1659, 'Iframe sandbox fails to load app preview', 'open');
    });

    const result = await dupe_cluster({ repo: 'o/r', issue_number: 1659, max_candidates: 10 });
    expect(result.signals).not.toContain('duplicate');
    expect(result.evidence).toEqual([]);
  });

  it('keeps medium-confidence duplicates as evidence without a blocking signal', async () => {
    githubMocks.githubJson.mockImplementation(async (requestPath: string) => {
      if (/^\/repos\/[^/]+\/[^/]+$/.test(requestPath)) {
        return { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
      }
      if (requestPath.includes('/search/issues')) {
        return { items: [issue(42, 'Preview iframe fails', 'open', 'npx is not available when launching the sandbox')] };
      }
      if (requestPath.includes('/issues?')) return [];
      if (requestPath.includes('/issues/7')) {
        return issue(7, 'Sandbox boot error', 'open', 'npx is not available when launching the sandbox');
      }
      return issue(7, 'Sandbox boot error', 'open');
    });

    const result = await dupe_cluster({ repo: 'o/r', issue_number: 7, max_candidates: 10 });
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence[0]?.score).toBeGreaterThanOrEqual(0.35);
    expect(result.evidence[0]?.score).toBeLessThan(0.65);
    expect(result.signals).not.toContain('duplicate');
  });

  it('does not emit released_fix when versions match but no probe was provided', async () => {
    const result = await release_gap({ repo: 'o/r', npm_package: 'demo', force_refresh: true });
    expect(result.signals).not.toContain('released_fix');
    expect(result.not_checked.join(' ')).toContain('Issue-specific artifact contents were not checked because no probe was provided.');
  });

  it('does not emit released_fix when a probe runs with zero matches', async () => {
    const result = await release_gap({
      repo: 'o/r',
      npm_package: 'demo',
      probe: { file_glob: 'dist/**/*.js', contains: 'definitely-not-present' },
      force_refresh: true
    });
    expect(result.signals).not.toContain('released_fix');
    expect(JSON.stringify(result.evidence)).toContain('probe ran; no issue-specific match found in the published artifact');
    expect(result.evidence.some((item) => item.matched === false)).toBe(true);
  });

  it('emits released_fix when the probe matched', async () => {
    const result = await release_gap({
      repo: 'o/r',
      npm_package: 'demo',
      probe: { file_glob: 'dist/**/index.js', contains: 'shipped' },
      force_refresh: true
    });
    expect(result.signals).toContain('released_fix');
    expect(result.evidence.some((item) => item.matched === true)).toBe(true);
  });
});

describe('eval compare-only mode', () => {
  it('only writes fixtures when --update-fixtures is present', async () => {
    const source = await readFile(new URL('../eval/run-eval.ts', import.meta.url), 'utf8');
    expect(source).toContain("process.argv.includes('--update-fixtures')");
    expect(source).toContain("mode: ${updateFixtures ? 'update-fixtures' : 'compare-only'}");
    expect(source).toContain('if (updateFixtures) await writeFile');

    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-eval-'));
    const fixturePath = path.join(fixtureDir, 'case-1.json');
    const original = `${JSON.stringify({ keep: true }, null, 2)}\n`;
    await writeFile(fixturePath, original);

    const updateFixtures = ['node', 'eval/run-eval.ts'].includes('--update-fixtures');
    expect(updateFixtures).toBe(false);
    if (updateFixtures) await writeFile(fixturePath, `${JSON.stringify({ mutated: true }, null, 2)}\n`);
    await expect(readFile(fixturePath, 'utf8')).resolves.toBe(original);

    const updateArgv = ['node', 'eval/run-eval.ts', '--update-fixtures'];
    expect(updateArgv.includes('--update-fixtures')).toBe(true);
    await rm(fixtureDir, { recursive: true, force: true });
  });
});
