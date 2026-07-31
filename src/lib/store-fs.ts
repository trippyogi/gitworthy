import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { GitworthyError } from '../core/envelope.js';

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_WAIT_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 50;

export function storeRoot(): string {
  return process.env.GITWORTHY_STORE_DIR || path.join(homedir(), '.gitworthy', 'store');
}

export function storeLockDir(): string {
  return path.join(storeRoot(), '.locks');
}

function lockPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._#-]+/g, '_');
  return path.join(storeLockDir(), `${safe}.lock`);
}

type LockHandle = {
  name: string;
  file: string;
  release: () => Promise<void>;
};

async function isLockStale(file: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(file);
    return Date.now() - info.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Cross-process exclusive lock via O_EXCL lockfiles.
 * Stale locks (mtime older than staleMs) are removed and retried.
 */
export async function withStoreLock<T>(
  name: string,
  run: () => Promise<T>,
  opts: { waitMs?: number; staleMs?: number; pollMs?: number } = {}
): Promise<T> {
  const waitMs = opts.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const file = lockPath(name);
  await mkdir(path.dirname(file), { recursive: true });

  const deadline = Date.now() + waitMs;
  let handle: LockHandle | undefined;

  while (!handle) {
    try {
      const fh = await open(file, 'wx');
      const payload = `${process.pid}\n${new Date().toISOString()}\n`;
      await fh.writeFile(payload, 'utf8');
      await fh.close();
      handle = {
        name,
        file,
        release: async () => {
          await rm(file, { force: true }).catch(() => undefined);
        }
      };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
      if (code !== 'EEXIST') {
        throw new GitworthyError({
          code: 'store_lock_failed',
          message: `Failed to acquire store lock ${name}.`,
          not_checked: [`Store lock ${name} could not be acquired.`]
        });
      }
      if (await isLockStale(file, staleMs)) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new GitworthyError({
          code: 'store_lock_timeout',
          message: `Timed out waiting for store lock ${name}.`,
          not_checked: [`Store lock ${name} was busy.`]
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  try {
    return await run();
  } finally {
    await handle.release();
  }
}

/** Atomic JSON write: temp file + rename into place. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'ENOENT') return null;
    throw error;
  }
}
