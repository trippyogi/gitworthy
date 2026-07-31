import { describe, expect, it } from 'vitest';
import { GitworthyError } from '../../src/core/envelope.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TREE_FILES,
  listTreeFiles,
  readTreeFile,
  readTreeFilesBatch
} from '../../src/lib/git.js';
import { DEFAULT_TARBALL_CAPS, inspectTarball } from '../../src/lib/registry.js';
import { commitFixtureFiles, initGitFixture } from '../helpers/git-fixture.js';
import { buildTar, tarEntry, tarballHttpClient } from '../helpers/tar-fixture.js';

/**
 * GW-014: per-file and aggregate resource budgets for both content sources
 * (git object trees, npm tarballs). Complements the budget tests already in
 * test/lib/git.test.ts and test/lib/registry-tarball.test.ts with boundary
 * conditions, multi-dimension interactions, and a regression guard on the
 * default cap values themselves (silently loosening a default is as
 * dangerous as a logic bug in the enforcement code).
 */

describe('default budget values are pinned (regression guard)', () => {
  it('git object-reader defaults have not silently changed', () => {
    expect(DEFAULT_MAX_TREE_FILES).toBe(20_000);
    expect(DEFAULT_MAX_FILE_BYTES).toBe(300_000);
  });

  it('npm tarball inspector defaults have not silently changed', () => {
    expect(DEFAULT_TARBALL_CAPS).toEqual({
      maxEntries: 20_000,
      maxEntryBytes: 25 * 1024 * 1024,
      maxTotalBytes: 150 * 1024 * 1024,
      timeoutMs: 30_000
    });
  });
});

describe('git: combined per-file, binary, and aggregate budgets', () => {
  it('applies the per-file cap and binary sniff together in a single batch read', async () => {
    const fixture = await initGitFixture('gitworthy-sec-git-combined-budget-');
    try {
      await commitFixtureFiles(fixture.dir, {
        'small-a.txt': 'a'.repeat(20),
        'oversized.txt': 'c'.repeat(500),
        'binary.bin': 'PNG\u0000hostile-binary-payload'
      });
      const { files } = await listTreeFiles(fixture.dir);
      const results = await readTreeFilesBatch(fixture.dir, files, { maxBytes: 100 });

      // oversized.txt fails the per-file size cap before content is ever read.
      expect(results.get('oversized.txt')).toBeNull();
      // binary.bin passes the size cap (its declared size is small) but is
      // excluded by the binary-content sniff once its bytes are inspected.
      expect(results.get('binary.bin')).toBeNull();
      expect(results.get('small-a.txt')).toBe('a'.repeat(20));
    } finally {
      await fixture.cleanup();
    }
  });

  it('reserves aggregate budget by declared size before content-based binary sniffing can exclude a blob', async () => {
    const fixture = await initGitFixture('gitworthy-sec-git-budget-reservation-');
    try {
      // A hostile repo could front-load many small "maybe binary" blobs to
      // consume the aggregate byte budget before any legitimate text file is
      // reached, since size-based budget reservation happens before content
      // is read (and thus before binary content can be identified and excluded).
      await commitFixtureFiles(fixture.dir, {
        'aaa-binary.bin': 'PNG\u0000binary-payload-of-notable-length',
        'zzz-legit.txt': 'legitimate text content\n'
      });
      const { files } = await listTreeFiles(fixture.dir);
      const binarySize = Buffer.byteLength('PNG\u0000binary-payload-of-notable-length', 'utf8');
      // A tight aggregate budget that the binary blob alone exhausts.
      const results = await readTreeFilesBatch(fixture.dir, files, { maxTotalBytes: binarySize });

      expect(results.get('aaa-binary.bin')).toBeNull(); // excluded by binary sniff
      expect(results.get('zzz-legit.txt')).toBeNull(); // budget already reserved by the binary blob's size
    } finally {
      await fixture.cleanup();
    }
  });

  it('caps tracked file enumeration at exactly maxFiles (boundary: cap vs cap+1)', async () => {
    const fixture = await initGitFixture('gitworthy-sec-git-boundary-');
    try {
      await commitFixtureFiles(fixture.dir, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });

      const atCap = await listTreeFiles(fixture.dir, { maxFiles: 3 });
      expect(atCap.files).toHaveLength(3);
      expect(atCap.truncated).toBe(false);

      const overCap = await listTreeFiles(fixture.dir, { maxFiles: 2 });
      expect(overCap.files).toHaveLength(2);
      expect(overCap.truncated).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('a blob exactly at the byte cap is read; one byte over is refused', async () => {
    const fixture = await initGitFixture('gitworthy-sec-git-bytecap-boundary-');
    try {
      await commitFixtureFiles(fixture.dir, { 'exact.txt': 'x'.repeat(50), 'over.txt': 'x'.repeat(51) });
      const { files } = await listTreeFiles(fixture.dir);
      const exact = files.find((f) => f.path === 'exact.txt')!;
      const over = files.find((f) => f.path === 'over.txt')!;

      expect(await readTreeFile(fixture.dir, exact, { maxBytes: 50 })).toBe('x'.repeat(50));
      expect(await readTreeFile(fixture.dir, over, { maxBytes: 50 })).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('tar: entry-count and byte budgets, including boundaries', () => {
  it('accepts exactly maxEntries entries but rejects one more (off-by-one boundary)', async () => {
    const atCapEntries = Array.from({ length: 10 }, (_, i) => tarEntry({ path: `package/file-${i}.txt`, content: 'x' }));
    const atCapTar = buildTar(atCapEntries);
    const atCapResult = await inspectTarball('https://example.com/pkg-1.0.0.tgz', {
      matches: () => true,
      readContent: false,
      caps: { maxEntries: 10 },
      httpClient: tarballHttpClient(atCapTar)
    });
    expect(atCapResult.entriesScanned).toBe(10);

    const overCapEntries = Array.from({ length: 11 }, (_, i) => tarEntry({ path: `package/file-${i}.txt`, content: 'x' }));
    const overCapTar = buildTar(overCapEntries);
    await expect(inspectTarball('https://example.com/pkg-1.0.0.tgz', {
      matches: () => true,
      readContent: false,
      caps: { maxEntries: 10 },
      httpClient: tarballHttpClient(overCapTar)
    })).rejects.toMatchObject({ code: 'npm_tarball_budget_exceeded' });
  });

  it('does not discard successfully collected matches when the archive fits under budget', async () => {
    // Sanity check for the boundary test above: a well-behaved archive under
    // every cap must still return its matches (guards against an inverted condition).
    const tar = buildTar([
      tarEntry({ path: 'package/a.txt', content: 'alpha' }),
      tarEntry({ path: 'package/b.txt', content: 'bravo' })
    ]);
    const result = await inspectTarball('https://example.com/pkg-1.0.0.tgz', {
      matches: () => true,
      readContent: true,
      caps: { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 1000 },
      httpClient: tarballHttpClient(tar)
    });
    expect(result.matches.map((m) => m.path).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('a metadata-only scan (readContent: false) never consumes the aggregate byte budget', async () => {
    // maxEntryBytes still gates which entries are even considered (by declared
    // size), but a metadata-only scan must never read bytes into memory, so the
    // aggregate maxTotalBytes cap can be far smaller than the entry itself.
    const tar = buildTar([
      tarEntry({ path: 'package/listed.txt', content: 'x'.repeat(1000) })
    ]);
    const result = await inspectTarball('https://example.com/pkg-1.0.0.tgz', {
      matches: () => true,
      readContent: false,
      caps: { maxEntryBytes: 2000, maxTotalBytes: 10 },
      httpClient: tarballHttpClient(tar)
    });
    expect(result.matches.map((m) => m.path)).toEqual(['listed.txt']);
    expect(result.bytesRead).toBe(0);
  });

  it('discards partially-collected matches when the aggregate byte budget trips (fail-closed, not fail-partial)', async () => {
    const tar = buildTar([
      tarEntry({ path: 'package/first.js', content: 'a'.repeat(80) }),
      tarEntry({ path: 'package/second.js', content: 'b'.repeat(80) })
    ]);
    const promise = inspectTarball('https://example.com/pkg-1.0.0.tgz', {
      matches: () => true,
      readContent: true,
      caps: { maxEntryBytes: 1000, maxTotalBytes: 100 },
      httpClient: tarballHttpClient(tar)
    });
    // The whole call must reject — a caller must never be handed a partial,
    // silently-truncated match list and mistake it for a complete scan.
    await expect(promise).rejects.toBeInstanceOf(GitworthyError);
    await expect(promise).rejects.toMatchObject({ code: 'npm_tarball_budget_exceeded' });
  });
});
