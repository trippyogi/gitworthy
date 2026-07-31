import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { release_gap } from '../src/core/release-gap.js';
import type { TarballInspectOptions, TarballInspectResult, TarballMatch } from '../src/lib/registry.js';
import { commitFixtureFiles, initGitFixture } from './helpers/git-fixture.js';

let cloneDir: string;
let cleanupClone: () => Promise<void>;
let tarballEntries: TarballMatch[];

vi.mock('../src/lib/git.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/git.js')>('../src/lib/git.js');
  return {
    ...actual,
    shallowClone: vi.fn(async () => ({ dir: cloneDir, cleanup: async () => undefined }))
  };
});

vi.mock('../src/lib/registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/registry.js')>('../src/lib/registry.js');
  return {
    ...actual,
    npmMetadata: vi.fn(async () => ({
      name: '@elevenlabs/cli',
      'dist-tags': { latest: '0.5.5' },
      versions: { '0.5.5': { version: '0.5.5', dist: { tarball: 'https://registry.npmjs.org/@elevenlabs/cli/-/cli-0.5.5.tgz' } } },
      time: { '0.5.5': '2026-07-06T16:22:18.825Z' }
    })),
    inspectTarball: vi.fn(async (_url: string, options: TarballInspectOptions): Promise<TarballInspectResult> => {
      const matches: TarballMatch[] = [];
      for (const entry of tarballEntries) {
        if (!options.matches(entry.path)) continue;
        matches.push(options.readContent ? entry : { path: entry.path, size: entry.size });
      }
      return { matches, entriesScanned: tarballEntries.length, bytesRead: 0 };
    })
  };
});

describe('release_gap probe signal', () => {
  beforeEach(async () => {
    const clone = await initGitFixture('gitworthy-release-clone-');
    cloneDir = clone.dir;
    cleanupClone = clone.cleanup;
    await commitFixtureFiles(cloneDir, {
      'package.json': JSON.stringify({ name: '@elevenlabs/cli', version: '0.5.5' })
    });
    tarballEntries = [
      { path: 'dist/commands/add.js', size: 41, content: 'spawn(command, args, { shell: true });\n' }
    ];
  });

  afterEach(async () => {
    await cleanupClone();
  });

  it('emits released_fix when main equals npm latest and the probe matches', async () => {
    const result = await release_gap({ repo: 'elevenlabs/cli', npm_package: '@elevenlabs/cli', probe: { file_glob: 'dist/**/add.js', contains: 'shell: true' }, force_refresh: true });
    expect(result.signals).toContain('released_fix');
    expect(JSON.stringify(result.evidence)).toContain('shell: true');
  });

  it('resolves probe_template to a probe when no explicit probe is given', async () => {
    const result = await release_gap({ repo: 'elevenlabs/cli', npm_package: '@elevenlabs/cli', probe_template: 'package-exports', force_refresh: true });
    expect(result.checked.some((item) => item.includes('resolved probe_template "package-exports"'))).toBe(true);
    const probeEvidence = result.evidence.find((item) => item.probe !== undefined) as { probe: { file_glob?: string; contains?: string } } | undefined;
    expect(probeEvidence?.probe).toEqual({ file_glob: '**/package.json', contains: '"exports"' });
  });

  it('prefers an explicit probe over probe_template when both are provided', async () => {
    const result = await release_gap({
      repo: 'elevenlabs/cli',
      npm_package: '@elevenlabs/cli',
      probe: { file_glob: 'dist/**/add.js', contains: 'shell: true' },
      probe_template: 'package-exports',
      force_refresh: true
    });
    expect(result.signals).toContain('released_fix');
    expect(result.checked.some((item) => item.includes('resolved probe_template'))).toBe(false);
  });

  it('notes an unknown probe_template id instead of applying a probe', async () => {
    const result = await release_gap({ repo: 'elevenlabs/cli', npm_package: '@elevenlabs/cli', probe_template: 'not-a-template', force_refresh: true });
    expect(result.not_checked.some((item) => item.includes('not-a-template') && item.includes('not a known template id'))).toBe(true);
  });

  it('runs an existence probe for file_glob-only templates like changelog', async () => {
    tarballEntries.push({ path: 'CHANGELOG.md', size: 10 });
    const result = await release_gap({ repo: 'elevenlabs/cli', npm_package: '@elevenlabs/cli', probe_template: 'changelog', force_refresh: true });
    expect(result.checked.some((item) => item.includes('resolved probe_template "changelog"'))).toBe(true);
    expect(result.not_checked.some((item) => item.includes('no probe was provided'))).toBe(false);
    const probeEvidence = result.evidence.find((item) => item.probe !== undefined) as { matched: boolean; matches: Array<{ path: string }> } | undefined;
    expect(probeEvidence?.matched).toBe(true);
    expect(probeEvidence?.matches.some((match) => match.path === 'CHANGELOG.md')).toBe(true);
    expect(result.signals).not.toContain('released_fix');
  });

  it('merges probe_template file_glob with explicit probe contains', async () => {
    tarballEntries.push({ path: 'CHANGELOG.md', size: 24, content: 'Fixed shell: true spawn\n' });
    const result = await release_gap({
      repo: 'elevenlabs/cli',
      npm_package: '@elevenlabs/cli',
      probe_template: 'changelog',
      probe: { contains: 'shell: true' },
      force_refresh: true
    });
    expect(result.checked.some((item) => item.includes('resolved probe_template "changelog"'))).toBe(true);
    expect(result.signals).toContain('released_fix');
    const probeEvidence = result.evidence.find((item) => item.probe !== undefined) as { probe: { file_glob?: string; contains?: string } } | undefined;
    expect(probeEvidence?.probe).toEqual({ file_glob: '**/CHANGELOG*', contains: 'shell: true' });
  });
});

describe('globMatch', () => {
  it('matches trailing * and .* patterns used by probe templates', async () => {
    const { globMatch } = await import('../src/core/release-gap.js');
    expect(globMatch('CHANGELOG.md', '**/CHANGELOG*')).toBe(true);
    expect(globMatch('docs/CHANGELOG', '**/CHANGELOG*')).toBe(true);
    expect(globMatch('README.md', '**/README*')).toBe(true);
    expect(globMatch('dist/index.js', '**/dist/index.*')).toBe(true);
    expect(globMatch('dist/index.d.ts', '**/dist/index.*')).toBe(true);
    expect(globMatch('src/index.ts', '**/src/index.*')).toBe(true);
    expect(globMatch('package.json', '**/package.json')).toBe(true);
    expect(globMatch('lib/other.js', '**/dist/index.*')).toBe(false);
  });
});
