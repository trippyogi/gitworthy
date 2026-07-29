import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { GitworthyError } from '../core/envelope.js';

export type RemoteHead = { name: string; sha: string };

const HEADS_TTL_MS = 5 * 60 * 1000;
const CLONE_IDLE_MS = 10 * 60 * 1000;

const headsCache = new Map<string, { heads: RemoteHead[]; fetched_at: number }>();
type CloneLease = { dir: string; refs: number; idleTimer?: ReturnType<typeof setTimeout> };
const clonePool = new Map<string, CloneLease>();

export async function lsRemoteHeads(repo: string, force_refresh = false): Promise<RemoteHead[]> {
  const cached = headsCache.get(repo);
  if (!force_refresh && cached && Date.now() - cached.fetched_at < HEADS_TTL_MS) {
    return cached.heads;
  }
  const remote = `https://github.com/${repo}.git`;
  try {
    const { stdout } = await execa('git', ['ls-remote', '--heads', remote]);
    const heads = stdout.split('\n').filter(Boolean).map((line) => {
      const [sha, ref] = line.split(/\s+/);
      return { sha, name: ref.replace('refs/heads/', '') };
    });
    headsCache.set(repo, { heads, fetched_at: Date.now() });
    return heads;
  } catch {
    throw new GitworthyError({ code: 'git_ls_remote_failed', message: `git ls-remote failed for ${repo}.`, not_checked: [`Remote heads were not checked for ${repo}.`] });
  }
}

async function createClone(repo: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-'));
  try {
    await execa('git', ['clone', '--depth', '1', `https://github.com/${repo}.git`, dir]);
    return dir;
  } catch {
    await rm(dir, { recursive: true, force: true });
    throw new GitworthyError({ code: 'git_clone_failed', message: `git shallow clone failed for ${repo}.`, not_checked: [`Repository tree was not checked for ${repo}.`] });
  }
}

async function evictClone(repo: string): Promise<void> {
  const lease = clonePool.get(repo);
  if (!lease || lease.refs > 0) return;
  clonePool.delete(repo);
  if (lease.idleTimer) clearTimeout(lease.idleTimer);
  await rm(lease.dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Shallow-clone with a per-repo pool so consecutive checks on the same repo reuse one tree. */
export async function shallowClone(repo: string): Promise<{ dir: string; cleanup: () => Promise<void>; cached: boolean }> {
  let lease = clonePool.get(repo);
  let cached = true;
  if (!lease) {
    cached = false;
    const dir = await createClone(repo);
    lease = { dir, refs: 0 };
    clonePool.set(repo, lease);
  }
  lease.refs += 1;
  if (lease.idleTimer) {
    clearTimeout(lease.idleTimer);
    lease.idleTimer = undefined;
  }
  return {
    dir: lease.dir,
    cached,
    cleanup: async () => {
      const current = clonePool.get(repo);
      if (!current) return;
      current.refs = Math.max(0, current.refs - 1);
      if (current.refs === 0) {
        current.idleTimer = setTimeout(() => {
          void evictClone(repo);
        }, CLONE_IDLE_MS);
        // Allow process exit without waiting for idle eviction.
        current.idleTimer.unref?.();
      }
    }
  };
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execa('git', args, { cwd });
    return stdout;
  } catch {
    throw new GitworthyError({ code: 'git_command_failed', message: `git ${args.join(' ')} failed.`, not_checked: [`Git command failed: git ${args.join(' ')}.`] });
  }
}

/** Test helper: drop in-memory git caches. */
export async function resetGitCachesForTests(): Promise<void> {
  headsCache.clear();
  for (const repo of [...clonePool.keys()]) {
    const lease = clonePool.get(repo);
    if (lease?.idleTimer) clearTimeout(lease.idleTimer);
    if (lease) {
      lease.refs = 0;
      await rm(lease.dir, { recursive: true, force: true }).catch(() => undefined);
    }
    clonePool.delete(repo);
  }
}
