import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { packageVersion } from './package-meta.js';

export type CacheReadResult<T> = { hit: true; value: T; fetched_at: string } | { hit: false };

export function cacheRoot(): string {
  return process.env.GITWORTHY_CACHE_DIR || path.join(homedir(), '.gitworthy', 'cache');
}

export function cacheVersion(): string {
  if (process.env.GITWORTHY_CACHE_VERSION) return process.env.GITWORTHY_CACHE_VERSION;
  return packageVersion();
}

export function cacheKey(scope: string, args: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify({ version: cacheVersion(), args })).digest('hex');
  return path.join(cacheRoot(), scope, `${hash}.json`);
}

export async function readCache<T>(scope: string, args: unknown, ttlMs: number, force_refresh = false): Promise<CacheReadResult<T>> {
  if (force_refresh) return { hit: false };
  const file = cacheKey(scope, args);
  try {
    const meta = await stat(file);
    if (Date.now() - meta.mtimeMs > ttlMs) return { hit: false };
    const raw = JSON.parse(await readFile(file, 'utf8')) as { value: T; fetched_at: string };
    return { hit: true, value: raw.value, fetched_at: raw.fetched_at };
  } catch {
    return { hit: false };
  }
}

export async function writeCache<T>(scope: string, args: unknown, value: T, fetched_at = new Date().toISOString()): Promise<void> {
  const file = cacheKey(scope, args);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ value, fetched_at }, null, 2));
}

export async function deleteCache(scope: string, args: unknown): Promise<void> {
  const file = cacheKey(scope, args);
  try {
    await unlink(file);
  } catch {
    // missing cache entry is a successful bust
  }
}
