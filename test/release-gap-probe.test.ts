import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { release_gap } from '../src/core/release-gap.js';

let cloneDir: string;
let tarballDir: string;

vi.mock('../src/lib/git.js', () => ({
  shallowClone: vi.fn(async () => ({ dir: cloneDir, cleanup: async () => undefined }))
}));

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
    downloadAndExtractTarball: vi.fn(async () => ({ dir: tarballDir, cleanup: async () => undefined }))
  };
});

describe('release_gap probe signal', () => {
  beforeEach(async () => {
    cloneDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-release-clone-'));
    tarballDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-release-tarball-'));
    await writeFile(path.join(cloneDir, 'package.json'), JSON.stringify({ name: '@elevenlabs/cli', version: '0.5.5' }));
    await mkdir(path.join(tarballDir, 'package', 'dist', 'commands'), { recursive: true });
    await writeFile(path.join(tarballDir, 'package', 'dist', 'commands', 'add.js'), 'spawn(command, args, { shell: true });\n');
  });

  afterEach(async () => {
    await rm(cloneDir, { recursive: true, force: true });
    await rm(tarballDir, { recursive: true, force: true });
  });

  it('emits released_fix when main equals npm latest and the probe matches', async () => {
    const result = await release_gap({ repo: 'elevenlabs/cli', npm_package: '@elevenlabs/cli', probe: { file_glob: 'dist/**/add.js', contains: 'shell: true' }, force_refresh: true });
    expect(result.signals).toContain('released_fix');
    expect(JSON.stringify(result.evidence)).toContain('shell: true');
  });
});
