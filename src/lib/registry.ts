import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { list as tarList, type ReadEntry } from 'tar';
import { GitworthyError } from '../core/envelope.js';
import { createHttpClient, HttpClient, HttpClientError } from './http-client.js';

export type NpmMetadata = {
  name: string;
  'dist-tags': { latest: string };
  versions: Record<string, { version: string; dist: { tarball: string } }>;
  time: Record<string, string>;
};

export async function npmMetadata(packageName: string): Promise<NpmMetadata> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName).replace('%40', '@')}`;
  const response = await fetch(url, { headers: { 'user-agent': 'gitworthy' } });
  if (!response.ok) {
    throw new GitworthyError({ code: 'npm_metadata_error', message: `npm metadata request failed with status ${response.status}.`, status: response.status, not_checked: [`npm metadata was not checked for ${packageName}.`] });
  }
  return response.json() as Promise<NpmMetadata>;
}

export async function readPackageJsonFromClone(dir: string): Promise<{ version?: string; name?: string }> {
  return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { version?: string; name?: string };
}

/**
 * Caps that bound npm tarball inspection (GW-013). Tarballs are hostile
 * input: they are streamed and parsed incrementally, and never fully
 * buffered or extracted to disk.
 */
export type TarballCaps = {
  /** Total number of tar entries (files, dirs, links, ...) that may be scanned. */
  maxEntries: number;
  /** Maximum declared/actual size, in bytes, of any single entry whose content is read. */
  maxEntryBytes: number;
  /** Maximum sum of bytes read across all entries whose content is read. */
  maxTotalBytes: number;
  /** Wall-clock budget, in milliseconds, for the entire fetch + parse. */
  timeoutMs: number;
};

export const DEFAULT_TARBALL_CAPS: TarballCaps = {
  maxEntries: 20_000,
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalBytes: 150 * 1024 * 1024,
  timeoutMs: 30_000
};

export type TarballMatch = {
  /** Path relative to the package root, with the npm `package/` prefix stripped. Posix separators. */
  path: string;
  size: number;
  /** Only present when `readContent` was requested and the entry was actually read. */
  content?: string;
};

export type TarballInspectOptions = {
  /** Called with a normalized, traversal-safe relative path; return true to include the entry. */
  matches: (relativePath: string) => boolean;
  /** When true, the content of matched file entries is read (subject to size caps). */
  readContent: boolean;
  caps?: Partial<TarballCaps>;
  /** Test-only: inject a preconfigured HttpClient instead of the shared default. */
  httpClient?: HttpClient;
};

export type TarballInspectResult = {
  matches: TarballMatch[];
  /** Total tar entries observed (including skipped/unsafe/non-file entries). */
  entriesScanned: number;
  /** Total bytes of entry content actually read (bounded by maxTotalBytes). */
  bytesRead: number;
};

let defaultNpmHttp: HttpClient | undefined;

function npmHttpClient(): HttpClient {
  defaultNpmHttp ??= createHttpClient({ userAgent: 'gitworthy' });
  return defaultNpmHttp;
}

/**
 * Normalizes a raw tar entry path into a safe, package-relative posix path,
 * or returns undefined when the entry must never be treated as a content
 * source: absolute paths, `..` traversal segments, or empty paths.
 */
export function safeTarballRelativePath(entryPath: string): string | undefined {
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return undefined;
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0) return undefined;
  if (segments.some((segment) => segment === '..')) return undefined;
  if (segments[0] === 'package') segments.shift();
  if (segments.length === 0) return undefined;
  return segments.join('/');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function mapTarballHttpError(error: unknown, tarballUrl: string): Error {
  if (error instanceof GitworthyError) return error;
  if (error instanceof HttpClientError) {
    if (error.code === 'http_timeout') {
      return new GitworthyError({
        code: 'npm_tarball_timeout',
        message: error.message,
        not_checked: [`npm tarball request timed out for ${tarballUrl}.`]
      });
    }
    if (error.code === 'http_budget_exceeded') {
      return new GitworthyError({
        code: 'npm_tarball_budget_exceeded',
        message: error.message,
        not_checked: [`npm tarball request budget was exceeded for ${tarballUrl}.`]
      });
    }
  }
  // The shared timeout signal also aborts body streaming that happens after
  // the initial response headers arrive, which surfaces as a raw AbortError
  // rather than an HttpClientError.
  if (isAbortError(error)) {
    return new GitworthyError({
      code: 'npm_tarball_timeout',
      message: `npm tarball request timed out for ${tarballUrl}.`,
      not_checked: [`npm tarball was not fully read before the timeout for ${tarballUrl}.`]
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * node-tar's Parser is a Minipass stream. Node's `finished()` reports a false
 * `ERR_STREAM_PREMATURE_CLOSE` after a clean parse, so wait on Parser events.
 */
function waitForTarParser(parser: { once: (event: string, listener: () => void) => unknown }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    parser.once('end', settle);
    parser.once('finish', settle);
  });
}

/**
 * Streams and inspects an npm tarball without buffering the whole archive
 * or extracting it to disk (GW-013). Only entries that pass `matches()` and
 * are safe, regular files are ever read into memory, and every dimension of
 * resource usage (entry count, per-entry size, total bytes, wall clock) is
 * capped. Absolute paths, `..` traversal, and symlink/hardlink entries are
 * never used as content sources.
 */
export async function inspectTarball(tarballUrl: string, options: TarballInspectOptions): Promise<TarballInspectResult> {
  const caps: TarballCaps = { ...DEFAULT_TARBALL_CAPS, ...options.caps };
  const http = options.httpClient ?? npmHttpClient();

  let response: Response;
  try {
    const result = await http.request(tarballUrl, { github: false, timeoutMs: caps.timeoutMs, headers: { 'user-agent': 'gitworthy' } });
    response = result.response;
  } catch (error) {
    throw mapTarballHttpError(error, tarballUrl);
  }

  if (!response.ok || !response.body) {
    throw new GitworthyError({ code: 'npm_tarball_error', message: `npm tarball request failed with status ${response.status}.`, status: response.status, not_checked: [`npm tarball was not checked at ${tarballUrl}.`] });
  }

  const matches: TarballMatch[] = [];
  let entriesScanned = 0;
  let bytesRead = 0;
  let budgetError: GitworthyError | undefined;
  let parserError: Error | undefined;

  const failBudget = (message: string): void => {
    budgetError ??= new GitworthyError({
      code: 'npm_tarball_budget_exceeded',
      message,
      not_checked: [message]
    });
  };

  const parser = tarList({
    onReadEntry: (entry: ReadEntry) => {
      if (budgetError) {
        entry.resume();
        return;
      }
      entriesScanned += 1;
      if (entriesScanned > caps.maxEntries) {
        failBudget(`npm tarball exceeded the max entry count (${caps.maxEntries}) while reading ${tarballUrl}.`);
        entry.resume();
        return;
      }

      // Only plain files are ever valid content sources: directories, symlinks,
      // hardlinks, and other special types are drained and excluded from results.
      if (entry.type !== 'File') {
        entry.resume();
        return;
      }

      const relativePath = safeTarballRelativePath(entry.path);
      if (relativePath === undefined) {
        entry.resume();
        return;
      }

      if (entry.size > caps.maxEntryBytes) {
        entry.resume();
        return;
      }

      if (!options.matches(relativePath)) {
        entry.resume();
        return;
      }

      if (!options.readContent) {
        matches.push({ path: relativePath, size: entry.size });
        entry.resume();
        return;
      }

      const chunks: Buffer[] = [];
      let entryBytes = 0;
      entry.on('data', (chunk: Buffer) => {
        if (budgetError) return;
        entryBytes += chunk.length;
        bytesRead += chunk.length;
        if (entryBytes > caps.maxEntryBytes || bytesRead > caps.maxTotalBytes) {
          failBudget(`npm tarball exceeded the byte budget while reading ${relativePath} from ${tarballUrl}.`);
          return;
        }
        chunks.push(chunk);
      });
      entry.on('end', () => {
        if (budgetError) return;
        matches.push({ path: relativePath, size: entry.size, content: Buffer.concat(chunks).toString('utf8') });
      });
    }
  });

  // The parser can abort internally (malformed gzip, decompression-ratio bomb,
  // strict-mode archive errors). Without a listener, an unhandled 'error' event
  // on an EventEmitter throws and would crash the process.
  parser.on('error', (error: Error) => {
    parserError ??= error;
  });
  // Subscribe before any writes/`end` so a synchronous finish cannot be missed.
  const parserDrained = waitForTarParser(parser);

  const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
  try {
    for await (const chunk of nodeStream) {
      if (!parser.write(chunk as Buffer)) {
        await new Promise<void>((resolve) => {
          parser.once('drain', resolve);
        });
      }
      if (budgetError || parserError) break;
    }
    // Content matches are appended in per-entry `end` handlers (and gzip
    // decompression is asynchronous). Do not return until the parser has
    // fully drained; otherwise release_gap can miss released_fix probes.
    parser.end();
    await parserDrained;
  } catch (error) {
    parser.end();
    await parserDrained.catch(() => undefined);
    throw mapTarballHttpError(error, tarballUrl);
  } finally {
    nodeStream.destroy();
  }

  if (budgetError) throw budgetError;
  if (parserError) {
    throw new GitworthyError({
      code: 'npm_tarball_error',
      message: `npm tarball at ${tarballUrl} could not be parsed: ${parserError.message}`,
      not_checked: [`npm tarball was not fully checked at ${tarballUrl} because it could not be parsed.`]
    });
  }

  return { matches, entriesScanned, bytesRead };
}
