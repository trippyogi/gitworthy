import { describe, expect, it } from 'vitest';
import { listTreeFiles, readTreeFile, readTreeFilesBatch } from '../../src/lib/git.js';
import { inspectTarball, safeTarballRelativePath } from '../../src/lib/registry.js';
import { commitFixtureFiles, commitSymlinkBlob, initGitFixture } from '../helpers/git-fixture.js';
import { buildTar, tarEntry, tarballHttpClient } from '../helpers/tar-fixture.js';

/**
 * GW-014: path-traversal and symlink/hardlink hostility across both content
 * sources gitworthy reads from a target — git object trees and npm tarballs.
 *
 * The `git` side (see also test/lib/git.test.ts) never joins a tracked tree
 * path onto a filesystem path at all: content is always addressed by blob
 * sha through `git cat-file`, so a hostile/traversal-shaped tree entry name
 * can never be used to escape the repository. The `tar` side (see also
 * test/lib/registry-tarball.test.ts) normalizes and rejects `..`/absolute
 * entry paths before they are ever considered as a content source, and
 * symlink/hardlink entries are excluded purely by tar entry `type`,
 * independent of their declared link target.
 */

describe('git: tree path labels never reach the filesystem', () => {
  it('readTreeFile addresses content solely by blob sha, ignoring a hostile path label', async () => {
    const fixture = await initGitFixture('gitworthy-sec-git-label-');
    try {
      await commitFixtureFiles(fixture.dir, { 'safe.txt': 'legit content\n' });
      const { files: [safe] } = await listTreeFiles(fixture.dir);

      // A caller-supplied ClonedFile with a traversal-shaped `path` label but the
      // real blob sha: the traversal string must never be turned into an fs path.
      const hostile = { path: '../../../../etc/passwd', sha: safe!.sha, symlink: false };
      const content = await readTreeFile(fixture.dir, hostile);
      expect(content).toBe('legit content\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('readTreeFilesBatch keys results by the caller-supplied path label but reads content only via sha', async () => {
    const fixture = await initGitFixture('gitworthy-sec-git-batch-label-');
    try {
      await commitFixtureFiles(fixture.dir, { 'one.txt': 'one\n', 'two.txt': 'two\n' });
      const { files } = await listTreeFiles(fixture.dir);
      const bySha = new Map(files.map((file) => [file.path, file.sha]));

      const hostileFiles = [
        { path: '../../escape-one', sha: bySha.get('one.txt')!, symlink: false },
        { path: '/etc/escape-two', sha: bySha.get('two.txt')!, symlink: false }
      ];
      const results = await readTreeFilesBatch(fixture.dir, hostileFiles);
      expect(results.get('../../escape-one')).toBe('one\n');
      expect(results.get('/etc/escape-two')).toBe('two\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('never follows a symlink blob even when its target string names a real tracked file', async () => {
    const fixture = await initGitFixture('gitworthy-sec-git-symlink-chain-');
    try {
      await commitFixtureFiles(fixture.dir, { 'real.txt': 'real content\n' });
      await commitSymlinkBlob(fixture.dir, 'link-to-real', 'real.txt');

      const { files } = await listTreeFiles(fixture.dir);
      const link = files.find((file) => file.path === 'link-to-real');
      expect(link?.symlink).toBe(true);
      expect(await readTreeFile(fixture.dir, link!)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('readTreeFilesBatch returns an all-null map when every candidate is a symlink', async () => {
    const fixture = await initGitFixture('gitworthy-sec-git-batch-symlinks-');
    try {
      await commitFixtureFiles(fixture.dir, { 'placeholder.txt': 'x\n' });
      await commitSymlinkBlob(fixture.dir, 'link-a', '../../etc/passwd');
      await commitSymlinkBlob(fixture.dir, 'link-b', '/etc/shadow');

      const { files } = await listTreeFiles(fixture.dir);
      const symlinks = files.filter((file) => file.symlink);
      expect(symlinks).toHaveLength(2);

      const results = await readTreeFilesBatch(fixture.dir, symlinks);
      expect(results.get('link-a')).toBeNull();
      expect(results.get('link-b')).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('safeTarballRelativePath: additional traversal/absolute-path permutations', () => {
  it('rejects a UNC-style path', () => {
    expect(safeTarballRelativePath('\\\\server\\share\\evil.dll')).toBeUndefined();
  });

  it('rejects a lowercase drive-absolute backslash path', () => {
    expect(safeTarballRelativePath('c:\\Windows\\evil.dll')).toBeUndefined();
  });

  it('rejects traversal mixed with intermediate "." segments', () => {
    expect(safeTarballRelativePath('package/./../../etc/passwd')).toBeUndefined();
  });

  it('resolves to undefined when only "." segments remain after stripping the package/ prefix', () => {
    expect(safeTarballRelativePath('package/.')).toBeUndefined();
    expect(safeTarballRelativePath('package/./.')).toBeUndefined();
  });

  it('resolves to undefined for an empty path', () => {
    expect(safeTarballRelativePath('')).toBeUndefined();
  });
});

describe('tar: archive-link hostility (symlink/hardlink entries never contribute content)', () => {
  const hostileLinkTargets = [
    { label: 'absolute posix target', linkpath: '/etc/passwd' },
    { label: 'absolute windows target', linkpath: 'C:\\Windows\\System32\\config\\SAM' },
    { label: 'relative dot-dot target', linkpath: '../../../etc/shadow' },
    { label: 'in-package target', linkpath: 'package/real.js' }
  ];

  for (const { label, linkpath } of hostileLinkTargets) {
    it(`excludes a SymbolicLink entry as a content source regardless of its target (${label})`, async () => {
      const tar = buildTar([
        tarEntry({ path: 'package/dist/index.js', type: 'SymbolicLink', linkpath }),
        tarEntry({ path: 'package/real.js', content: 'console.log("shipped");\n' })
      ]);
      const result = await inspectTarball('https://example.com/pkg-1.0.0.tgz', {
        matches: () => true,
        readContent: true,
        httpClient: tarballHttpClient(tar)
      });
      expect(result.matches.map((m) => m.path)).toEqual(['real.js']);
    });

    it(`excludes a Link (hardlink) entry as a content source regardless of its target (${label})`, async () => {
      const tar = buildTar([
        tarEntry({ path: 'package/dist/other.js', type: 'Link', linkpath }),
        tarEntry({ path: 'package/real.js', content: 'console.log("shipped");\n' })
      ]);
      const result = await inspectTarball('https://example.com/pkg-1.0.0.tgz', {
        matches: () => true,
        readContent: true,
        httpClient: tarballHttpClient(tar)
      });
      expect(result.matches.map((m) => m.path)).toEqual(['real.js']);
    });
  }

  it('does not let a directory-shadowing symlink redirect a later file entry with a matching path prefix', async () => {
    const tar = buildTar([
      // A hostile package can ship a symlink named like a directory, then a
      // "file inside it" entry — but tar entries are independent, flat path
      // strings, and gitworthy never extracts to disk, so there is no real
      // directory to redirect through.
      tarEntry({ path: 'package/lib', type: 'SymbolicLink', linkpath: '/etc' }),
      tarEntry({ path: 'package/lib/passwd', content: 'not actually /etc/passwd\n' })
    ]);
    const result = await inspectTarball('https://example.com/pkg-1.0.0.tgz', {
      matches: () => true,
      readContent: true,
      httpClient: tarballHttpClient(tar)
    });
    expect(result.matches.map((m) => m.path)).toEqual(['lib/passwd']);
    expect(result.matches[0]?.content).toBe('not actually /etc/passwd\n');
  });

  it('excludes Directory-typed entries as content sources', async () => {
    const tar = buildTar([
      tarEntry({ path: 'package/dist', type: 'Directory' }),
      tarEntry({ path: 'package/dist/real.js', content: 'console.log("shipped");\n' })
    ]);
    const result = await inspectTarball('https://example.com/pkg-1.0.0.tgz', {
      matches: () => true,
      readContent: true,
      httpClient: tarballHttpClient(tar)
    });
    expect(result.matches.map((m) => m.path)).toEqual(['dist/real.js']);
  });
});
