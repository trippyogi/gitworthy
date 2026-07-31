import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../../src/lib/http-client.js';
import { GitworthyError } from '../../src/core/envelope.js';
import { inspectTarball, safeTarballRelativePath } from '../../src/lib/registry.js';
import { buildTar, hangingHttpClient, tarballHttpClient, tarEntry } from '../helpers/tar-fixture.js';

const clientFor = tarballHttpClient;

describe('safeTarballRelativePath', () => {
  it('strips the package/ prefix from ordinary entries', () => {
    expect(safeTarballRelativePath('package/dist/index.js')).toBe('dist/index.js');
  });

  it('rejects absolute posix paths', () => {
    expect(safeTarballRelativePath('/etc/passwd')).toBeUndefined();
  });

  it('rejects windows drive-absolute paths', () => {
    expect(safeTarballRelativePath('C:/Windows/System32/evil.dll')).toBeUndefined();
  });

  it('rejects any ".." traversal segment', () => {
    expect(safeTarballRelativePath('package/../../etc/passwd')).toBeUndefined();
    expect(safeTarballRelativePath('../evil.txt')).toBeUndefined();
  });

  it('keeps paths without a package/ prefix as-is when otherwise safe', () => {
    expect(safeTarballRelativePath('README.md')).toBe('README.md');
  });
});

describe('inspectTarball', () => {
  it('streams matching file entries and reads their content', async () => {
    const tar = buildTar([
      tarEntry({ path: 'package/dist/add.js', content: 'spawn(command, args, { shell: true });\n' }),
      tarEntry({ path: 'package/README.md', content: '# demo\n' })
    ]);

    const result = await inspectTarball('https://example.com/demo-1.0.0.tgz', {
      matches: (relative) => relative === 'dist/add.js',
      readContent: true,
      httpClient: clientFor(tar)
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('dist/add.js');
    expect(result.matches[0]?.content).toContain('shell: true');
    expect(result.entriesScanned).toBe(2);
  });

  it('awaits gzip decompression so content matches are not dropped', async () => {
    const { gzipSync } = await import('node:zlib');
    const tar = buildTar([
      tarEntry({ path: 'package/dist/add.js', content: 'spawn(command, args, { shell: true });\n' })
    ]);
    const tgz = gzipSync(tar);

    const result = await inspectTarball('https://example.com/demo-1.0.0.tgz', {
      matches: (relative) => relative === 'dist/add.js',
      readContent: true,
      httpClient: clientFor(tgz)
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.content).toContain('shell: true');
  });

  it('never treats zip-slip (..) or absolute-path entries as content sources', async () => {
    const tar = buildTar([
      tarEntry({ path: '../evil.txt', content: 'shell: true payload outside the package root' }),
      tarEntry({ path: '/etc/passwd', content: 'shell: true payload at an absolute path' }),
      tarEntry({ path: 'package/safe.txt', content: 'shell: true only here is legitimate' })
    ]);

    const result = await inspectTarball('https://example.com/demo-1.0.0.tgz', {
      matches: () => true,
      readContent: true,
      httpClient: clientFor(tar)
    });

    expect(result.matches.map((m) => m.path)).toEqual(['safe.txt']);
    expect(result.matches.every((m) => !(m.content ?? '').includes('outside the package root'))).toBe(true);
    expect(result.matches.every((m) => !(m.content ?? '').includes('at an absolute path'))).toBe(true);
  });

  it('never reads content through symlink or hardlink entries', async () => {
    const tar = buildTar([
      tarEntry({ path: 'package/dist/index.js', type: 'SymbolicLink', linkpath: '/etc/passwd' }),
      tarEntry({ path: 'package/dist/other.js', type: 'Link', linkpath: 'package/dist/real.js' }),
      tarEntry({ path: 'package/dist/real.js', content: 'console.log("shipped");\n' })
    ]);

    const result = await inspectTarball('https://example.com/demo-1.0.0.tgz', {
      matches: () => true,
      readContent: true,
      httpClient: clientFor(tar)
    });

    expect(result.matches.map((m) => m.path)).toEqual(['dist/real.js']);
  });

  it('skips entries larger than the per-entry byte cap without failing the whole scan', async () => {
    const bigContent = 'x'.repeat(200);
    const tar = buildTar([
      tarEntry({ path: 'package/dist/huge.js', content: bigContent }),
      tarEntry({ path: 'package/dist/small.js', content: 'console.log("ok");\n' })
    ]);

    const result = await inspectTarball('https://example.com/demo-1.0.0.tgz', {
      matches: () => true,
      readContent: true,
      caps: { maxEntryBytes: 100 },
      httpClient: clientFor(tar)
    });

    expect(result.matches.map((m) => m.path)).toEqual(['dist/small.js']);
  });

  it('throws a typed budget error once total read bytes exceed the cap', async () => {
    const tar = buildTar([
      tarEntry({ path: 'package/a.js', content: 'a'.repeat(80) }),
      tarEntry({ path: 'package/b.js', content: 'b'.repeat(80) }),
      tarEntry({ path: 'package/c.js', content: 'c'.repeat(80) })
    ]);

    const promise = inspectTarball('https://example.com/demo-1.0.0.tgz', {
      matches: () => true,
      readContent: true,
      caps: { maxEntryBytes: 1000, maxTotalBytes: 150 },
      httpClient: clientFor(tar)
    });

    await expect(promise).rejects.toMatchObject({ code: 'npm_tarball_budget_exceeded' });
    await expect(promise).rejects.toBeInstanceOf(GitworthyError);
  });

  it('throws a typed budget error once the entry count exceeds the cap (entry-count bomb)', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => tarEntry({ path: `package/file-${i}.txt`, content: 'x' }));
    const tar = buildTar(entries);

    const promise = inspectTarball('https://example.com/demo-1.0.0.tgz', {
      matches: () => true,
      readContent: false,
      caps: { maxEntries: 10 },
      httpClient: clientFor(tar)
    });

    await expect(promise).rejects.toMatchObject({ code: 'npm_tarball_budget_exceeded' });
  });

  it('maps a timed-out request to a typed timeout error', async () => {
    await expect(inspectTarball('https://example.com/demo-1.0.0.tgz', {
      matches: () => true,
      readContent: false,
      caps: { timeoutMs: 20 },
      httpClient: hangingHttpClient()
    })).rejects.toMatchObject({ code: 'npm_tarball_timeout' });
  });

  it('does not crash on a non-tar payload and reports no matches', async () => {
    const garbage = Buffer.from('this is definitely not a tar archive, just plain bytes'.repeat(20));
    const result = await inspectTarball('https://example.com/demo-1.0.0.tgz', {
      matches: () => true,
      readContent: true,
      httpClient: clientFor(garbage)
    });
    expect(result.matches).toEqual([]);
  });

  it('surfaces a typed error when the tarball request fails', async () => {
    const client = createHttpClient({
      transport: async () => new Response('not found', { status: 404 }),
      maxRetries: 0
    });

    await expect(inspectTarball('https://example.com/missing.tgz', {
      matches: () => true,
      readContent: false,
      httpClient: client
    })).rejects.toMatchObject({ code: 'npm_tarball_error' });
  });
});
