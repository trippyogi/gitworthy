import { Header } from 'tar';
import { createHttpClient, type HttpClient } from '../../src/lib/http-client.js';

export type TarEntryType = 'File' | 'Directory' | 'SymbolicLink' | 'Link';

export type TarEntryInput = {
  path: string;
  type?: TarEntryType;
  content?: string;
  /** Target for SymbolicLink/Link entries. */
  linkpath?: string;
  /** Override the declared entry size (e.g. to lie about a small body's size). */
  size?: number;
};

/** Hand-crafts a single raw (uncompressed) ustar entry: header block + zero-padded body. */
export function tarEntry(input: TarEntryInput): Buffer {
  const content = Buffer.from(input.content ?? '', 'utf8');
  const size = input.size ?? content.length;
  const header = new Header({
    path: input.path,
    type: input.type ?? 'File',
    size,
    mode: 0o644,
    mtime: new Date(0),
    linkpath: input.linkpath
  });
  const headerBuf = Buffer.alloc(512);
  header.encode(headerBuf);
  if (input.type === 'SymbolicLink' || input.type === 'Link' || input.type === 'Directory') {
    return headerBuf;
  }
  const paddedLen = Math.ceil(content.length / 512) * 512;
  const body = Buffer.alloc(paddedLen);
  content.copy(body);
  return Buffer.concat([headerBuf, body]);
}

/** Concatenates raw entries and appends the two-zero-block EOF marker required by ustar. */
export function buildTar(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

/** Convenience: crafts a full raw tar archive from entry specs in one call. */
export function craftTar(entries: TarEntryInput[]): Buffer {
  return buildTar(entries.map((entry) => tarEntry(entry)));
}

/** An HttpClient whose transport always resolves with the given tarball bytes. */
export function tarballHttpClient(tarball: Buffer, opts: { status?: number } = {}): HttpClient {
  return createHttpClient({
    transport: async () => new Response(tarball, { status: opts.status ?? 200 }),
    maxRetries: 0
  });
}

/**
 * An HttpClient whose transport never resolves on its own; it only rejects once the request's
 * AbortSignal fires, modeling a hostile/slow server for timeout tests.
 */
export function hangingHttpClient(): HttpClient {
  return createHttpClient({
    transport: async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
    maxRetries: 0
  });
}
