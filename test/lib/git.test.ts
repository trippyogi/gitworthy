import { afterEach, describe, expect, it } from 'vitest';
import { listTreeFiles, readClonedFile, readTreeFile, readTreeFilesBatch, resetGitCachesForTests } from '../../src/lib/git.js';
import { commitFixtureFiles, commitSymlinkBlob, initGitFixture } from '../helpers/git-fixture.js';

describe('git.ts safe object reader', () => {
  afterEach(async () => {
    await resetGitCachesForTests();
  });

  it('lists tracked files via git ls-tree without touching the fs, and never reads symlink blob targets', async () => {
    const fixture = await initGitFixture('gitworthy-git-symlink-');
    try {
      await commitFixtureFiles(fixture.dir, { 'regular.txt': 'hello world\n' });
      await commitSymlinkBlob(fixture.dir, 'evil-link', '../../../etc/passwd');

      const files = await listTreeFiles(fixture.dir);
      const regular = files.find((file) => file.path === 'regular.txt');
      const symlink = files.find((file) => file.path === 'evil-link');
      expect(regular?.symlink).toBe(false);
      expect(symlink?.symlink).toBe(true);

      // Even though the symlink blob's own content is a traversal string, the
      // safe reader must never treat it as an fs path to resolve/read.
      const content = await readTreeFile(fixture.dir, symlink!);
      expect(content).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('caps the number of tracked files considered', async () => {
    const fixture = await initGitFixture('gitworthy-git-filecap-');
    try {
      await commitFixtureFiles(fixture.dir, {
        'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'd.txt': 'd'
      });
      const files = await listTreeFiles(fixture.dir, { maxFiles: 2 });
      expect(files).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses to read a file larger than the byte budget', async () => {
    const fixture = await initGitFixture('gitworthy-git-bytecap-');
    try {
      await commitFixtureFiles(fixture.dir, { 'big.txt': 'x'.repeat(1000) });
      const [file] = await listTreeFiles(fixture.dir);
      const oversized = await readTreeFile(fixture.dir, file, { maxBytes: 10 });
      expect(oversized).toBeNull();
      const withinBudget = await readTreeFile(fixture.dir, file, { maxBytes: 10_000 });
      expect(withinBudget).toBe('x'.repeat(1000));
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns null for binary blobs instead of returning garbage content', async () => {
    const fixture = await initGitFixture('gitworthy-git-binary-');
    try {
      await commitFixtureFiles(fixture.dir, { 'image.bin': 'PNG\u0000fake-binary-payload' });
      const [file] = await listTreeFiles(fixture.dir);
      const content = await readTreeFile(fixture.dir, file);
      expect(content).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns null for a missing/unknown blob sha instead of throwing', async () => {
    const fixture = await initGitFixture('gitworthy-git-missing-');
    try {
      await commitFixtureFiles(fixture.dir, { 'regular.txt': 'hi\n' });
      const missing = { path: 'ghost.txt', sha: '0'.repeat(40), symlink: false };
      const content = await readTreeFile(fixture.dir, missing);
      expect(content).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('readClonedFile fails safe (returns null) for a repo with no active clone lease', async () => {
    const content = await readClonedFile('no-such/repo', 'package.json');
    expect(content).toBeNull();
  });

  describe('readTreeFilesBatch', () => {
    it('reads several files in a bounded number of subprocess calls and skips symlinks/binary/oversized entries', async () => {
      const fixture = await initGitFixture('gitworthy-git-batch-');
      try {
        await commitFixtureFiles(fixture.dir, {
          'a.txt': 'alpha\n',
          'b.txt': 'bravo\n',
          'big.txt': 'x'.repeat(1000),
          'image.bin': 'PNG\u0000binary-payload'
        });
        await commitSymlinkBlob(fixture.dir, 'evil-link', '../../../etc/passwd');

        const files = await listTreeFiles(fixture.dir);
        const results = await readTreeFilesBatch(fixture.dir, files, { maxBytes: 100 });

        expect(results.get('a.txt')).toBe('alpha\n');
        expect(results.get('b.txt')).toBe('bravo\n');
        expect(results.get('big.txt')).toBeNull(); // over the per-file byte budget
        expect(results.get('image.bin')).toBeNull(); // binary content
        expect(results.get('evil-link')).toBeNull(); // symlink, never followed
      } finally {
        await fixture.cleanup();
      }
    });

    it('enforces an aggregate byte budget across many small files', async () => {
      const fixture = await initGitFixture('gitworthy-git-batch-total-');
      try {
        await commitFixtureFiles(fixture.dir, {
          'one.txt': 'x'.repeat(50),
          'two.txt': 'y'.repeat(50),
          'three.txt': 'z'.repeat(50)
        });
        const files = await listTreeFiles(fixture.dir);
        const results = await readTreeFilesBatch(fixture.dir, files, { maxTotalBytes: 60 });
        const readCount = [...results.values()].filter((value) => value != null).length;
        // Budget of 60 bytes cannot fit more than one 50-byte file.
        expect(readCount).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    });

    it('returns an all-null map without throwing when the repo has no matching blobs', async () => {
      const fixture = await initGitFixture('gitworthy-git-batch-empty-');
      try {
        await commitFixtureFiles(fixture.dir, { 'regular.txt': 'hi\n' });
        const results = await readTreeFilesBatch(fixture.dir, []);
        expect(results.size).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    });
  });
});
