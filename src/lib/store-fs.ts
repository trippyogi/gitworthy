import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  token: string;
  release: () => Promise<void>;
};

async function readLockToken(file: string): Promise<{ token: string; createdAtMs: number } | null> {
  try {
    const raw = await readFile(file, 'utf8');
    const [token, createdAt] = raw.trim().split('\n');
    if (!token) return null;
    const createdAtMs = Date.parse(createdAt ?? '');
    return { token, createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0 };
  } catch {
    return null;
  }
}

async function isLockStale(file: string, staleMs: number): Promise<boolean> {
  const meta = await readLockToken(file);
  // Empty/corrupt lockfiles are treated as stale so waiters can reclaim instead of spinning.
  if (!meta) return true;
  if (!meta.createdAtMs) return true;
  return Date.now() - meta.createdAtMs > staleMs;
}

/**
 * Cross-process exclusive lock via O_EXCL lockfiles.
 * Stale locks (token timestamp older than staleMs) are removed and retried.
 * Release only deletes the lockfile when the token still matches this holder.
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
    const token = randomUUID();
    try {
      const fh = await open(file, 'wx');
      const payload = `${token}\n${new Date().toISOString()}\n${process.pid}\n`;
      await fh.writeFile(payload, 'utf8');
      await fh.close();
      handle = {
        name,
        file,
        token,
        release: async () => {
          const current = await readLockToken(file);
          if (current?.token === token) {
            await rm(file, { force: true }).catch(() => undefined);
          }
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
        const stale = await readLockToken(file);
        if (!stale) {
          await rm(file, { force: true }).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
        if (Date.now() - stale.createdAtMs > staleMs || !stale.createdAtMs) {
          const recheck = await readLockToken(file);
          if (!recheck || recheck.token === stale.token) {
            await rm(file, { force: true }).catch(() => undefined);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
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
    const deadline = Date.now() + 2_000;
    // Windows can transiently refuse replacing an existing file (AV / open handles).
    while (true) {
      try {
        await rename(tmp, file);
        return;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
        if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw error;
      }
    }
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
