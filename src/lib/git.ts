import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { GitworthyError } from '../core/envelope.js';

export type RemoteHead = { name: string; sha: string };

/** A tracked file discovered via `git ls-tree`, never a working-tree fs entry. */
export type ClonedFile = { path: string; sha: string; symlink: boolean };

const HEADS_TTL_MS = 5 * 60 * 1000;
const CLONE_IDLE_MS = 10 * 60 * 1000;

/** All `git` subprocesses (clone, ls-tree, cat-file, ls-remote) must be bounded. */
export const GIT_SUBPROCESS_TIMEOUT_MS = 15_000;
/** Hostile repos can have huge trees; cap how many blob paths we ever consider. */
export const DEFAULT_MAX_TREE_FILES = 20_000;
/** Per-file content read cap; oversized blobs are treated as unreadable, not truncated. */
export const DEFAULT_MAX_FILE_BYTES = 300_000;

const headsCache = new Map<string, { heads: RemoteHead[]; fetched_at: number }>();
type CloneLease = {
  dir: string;
  refs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  files?: ClonedFile[];
  pathIndex?: Map<string, ClonedFile>;
  treeTruncated?: boolean;
};
const clonePool = new Map<string, CloneLease>();
const cloneCreating = new Map<string, Promise<CloneLease>>();

export async function lsRemoteHeads(repo: string, force_refresh = false): Promise<RemoteHead[]> {
  const cached = headsCache.get(repo);
  if (!force_refresh && cached && Date.now() - cached.fetched_at < HEADS_TTL_MS) {
    return cached.heads;
  }
  const remote = `https://github.com/${repo}.git`;
  try {
    const { stdout } = await execa('git', ['ls-remote', '--heads', remote], { timeout: GIT_SUBPROCESS_TIMEOUT_MS });
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
    // --bare + --no-checkout leaves no working tree at all, so there is nothing to
    // walk with fs.readdir/fs.readFile and no working-tree symlink can ever be
    // resolved. All content inspection below goes through git plumbing instead.
    await execa('git', ['clone', '--bare', '--depth', '1', '--single-branch', `https://github.com/${repo}.git`, dir], { timeout: GIT_SUBPROCESS_TIMEOUT_MS });
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

async function acquireLease(repo: string): Promise<{ lease: CloneLease; cached: boolean }> {
  const existing = clonePool.get(repo);
  if (existing) return { lease: existing, cached: true };

  let creating = cloneCreating.get(repo);
  let cached = false;
  if (!creating) {
    creating = createClone(repo)
      .then((dir) => {
        const lease: CloneLease = { dir, refs: 0 };
        clonePool.set(repo, lease);
        cloneCreating.delete(repo);
        return lease;
      })
      .catch((error) => {
        cloneCreating.delete(repo);
        throw error;
      });
    cloneCreating.set(repo, creating);
  } else {
    cached = true;
  }
  const lease = await creating;
  return { lease: clonePool.get(repo) ?? lease, cached };
}

/** Bare-clone with a per-repo pool so consecutive checks on the same repo reuse one object store. */
export async function shallowClone(repo: string): Promise<{ dir: string; cleanup: () => Promise<void>; cached: boolean }> {
  const { lease, cached } = await acquireLease(repo);
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
      if (!current || current !== lease) return;
      current.refs = Math.max(0, current.refs - 1);
      if (current.refs === 0) {
        current.idleTimer = setTimeout(() => {
          void evictClone(repo);
        }, CLONE_IDLE_MS);
        current.idleTimer.unref?.();
      }
    }
  };
}

function parseLsTree(stdout: string, maxFiles: number): { files: ClonedFile[]; truncated: boolean } {
  const entries: ClonedFile[] = [];
  let truncated = false;
  for (const raw of stdout.split('\0')) {
    if (!raw) continue;
    const tabIndex = raw.indexOf('\t');
    if (tabIndex < 0) continue;
    const meta = raw.slice(0, tabIndex);
    const filePath = raw.slice(tabIndex + 1);
    const [mode, type, sha] = meta.split(' ');
    if (type !== 'blob' || !sha) continue;
    if (entries.length >= maxFiles) {
      truncated = true;
      break;
    }
    entries.push({ path: filePath.replace(/\\/g, '/'), sha, symlink: mode === '120000' });
  }
  return { files: entries, truncated };
}

/**
 * List blob paths tracked at `ref` by reading git's own tree objects
 * (`git ls-tree`), never by walking a checked-out working tree.
 */
export async function listTreeFiles(
  dir: string,
  opts: { ref?: string; maxFiles?: number; timeoutMs?: number } = {}
): Promise<{ files: ClonedFile[]; truncated: boolean }> {
  const ref = opts.ref ?? 'HEAD';
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_TREE_FILES;
  try {
    const { stdout } = await execa('git', ['ls-tree', '-r', '-z', ref], { cwd: dir, timeout: opts.timeoutMs ?? GIT_SUBPROCESS_TIMEOUT_MS });
    return parseLsTree(stdout, maxFiles);
  } catch {
    throw new GitworthyError({ code: 'git_ls_tree_failed', message: `git ls-tree failed in ${dir}.`, not_checked: [`Repository tree was not checked in ${dir}.`] });
  }
}

/**
 * Read a tracked blob's content directly from the object database
 * (`git cat-file`), enforcing a byte budget and never dereferencing
 * symlink entries. Returns null for symlinks, oversized blobs, binary
 * blobs, or any git failure (missing object, timeout, etc.) — content
 * inspection degrades to "not checked" rather than throwing.
 */
export async function readTreeFile(dir: string, file: ClonedFile, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<string | null> {
  if (file.symlink) return null;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const timeout = opts.timeoutMs ?? GIT_SUBPROCESS_TIMEOUT_MS;

  let size: number;
  try {
    const { stdout } = await execa('git', ['cat-file', '-s', file.sha], { cwd: dir, timeout });
    size = Number.parseInt(stdout.trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isFinite(size) || size > maxBytes) return null;

  try {
    // `cat-file -p` writes raw blob bytes with no trailing separator of its own, so a blob whose
    // content legitimately ends in `\n` must not have execa's default final-newline stripping
    // silently eat that last byte.
    const { stdout } = await execa('git', ['cat-file', '-p', file.sha], { cwd: dir, timeout, encoding: 'buffer', maxBuffer: maxBytes + 4096, stripFinalNewline: false });
    const buffer = Buffer.from(stdout as unknown as Uint8Array);
    if (buffer.includes(0)) return null; // binary content, safe no-op
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

async function batchBlobSizes(dir: string, shas: string[], timeout: number): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (shas.length === 0) return sizes;
  try {
    const { stdout } = await execa('git', ['cat-file', '--batch-check'], { cwd: dir, timeout, input: `${shas.join('\n')}\n` });
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const parts = line.split(' ');
      if (parts.length < 3 || parts[1] !== 'blob') continue; // "<sha> missing" or ambiguous
      const size = Number.parseInt(parts[2], 10);
      if (Number.isFinite(size)) sizes.set(parts[0], size);
    }
  } catch {
    // Leave sizes empty; callers treat unknown sizes as unreadable.
  }
  return sizes;
}

/** Parse `git cat-file --batch` output: `<sha> blob <size>\n<size bytes>\n` per requested object. */
function parseBatchContents(buffer: Buffer, shas: string[]): Map<string, string | null> {
  const results = new Map<string, string | null>();
  let offset = 0;
  for (const sha of shas) {
    if (offset >= buffer.length) break;
    const headerEnd = buffer.indexOf(0x0a, offset);
    if (headerEnd < 0) break;
    const header = buffer.toString('utf8', offset, headerEnd);
    offset = headerEnd + 1;
    const parts = header.split(' ');
    if (parts.length < 3 || parts[1] !== 'blob') continue; // "<sha> missing"
    const size = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(size) || offset + size > buffer.length) break;
    const content = buffer.subarray(offset, offset + size);
    results.set(sha, content.includes(0) ? null : content.toString('utf8'));
    offset += size + 1; // trailing LF after object content
  }
  return results;
}

async function batchBlobContents(dir: string, shas: string[], sizes: Map<string, number>, timeout: number): Promise<Map<string, string | null>> {
  if (shas.length === 0) return new Map();
  const totalBytes = shas.reduce((sum, sha) => sum + (sizes.get(sha) ?? 0), 0);
  try {
    const result = await execa('git', ['cat-file', '--batch'], {
      cwd: dir,
      timeout,
      input: `${shas.join('\n')}\n`,
      encoding: 'buffer',
      maxBuffer: totalBytes + shas.length * 64 + 4096
    });
    const buffer = Buffer.from(result.stdout as unknown as Uint8Array);
    return parseBatchContents(buffer, shas);
  } catch {
    return new Map();
  }
}

/**
 * Read many tracked blobs' content in a small, fixed number of `git`
 * subprocesses (`cat-file --batch-check` + `cat-file --batch`) instead of
 * spawning one process per file — important both for perf and so a hostile
 * repo with thousands of files cannot force unbounded subprocess fan-out.
 * Symlinks, oversized blobs, blobs that would blow the aggregate byte
 * budget, and binary blobs all map to `null`.
 */
export async function readTreeFilesBatch(
  dir: string,
  files: ClonedFile[],
  opts: { maxBytes?: number; maxTotalBytes?: number; timeoutMs?: number } = {}
): Promise<Map<string, string | null>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? Number.POSITIVE_INFINITY;
  const timeout = opts.timeoutMs ?? GIT_SUBPROCESS_TIMEOUT_MS;
  const results = new Map<string, string | null>();

  const candidates = files.filter((file) => !file.symlink);
  for (const file of files) if (file.symlink) results.set(file.path, null);
  if (candidates.length === 0) return results;

  const uniqueShas = [...new Set(candidates.map((file) => file.sha))];
  const sizes = await batchBlobSizes(dir, uniqueShas, timeout);

  // If batch-check failed entirely, fall back to per-file reads so one bad
  // subprocess does not zero out the whole grep (matches the old per-file
  // degrade-to-null behavior).
  if (sizes.size === 0 && uniqueShas.length > 0) {
    let runningTotal = 0;
    for (const file of candidates) {
      if (results.has(file.path)) continue;
      if (runningTotal >= maxTotalBytes) {
        results.set(file.path, null);
        continue;
      }
      const content = await readTreeFile(dir, file, { maxBytes, timeoutMs: timeout });
      if (content != null) {
        const bytes = Buffer.byteLength(content, 'utf8');
        if (runningTotal + bytes > maxTotalBytes) {
          results.set(file.path, null);
          continue;
        }
        runningTotal += bytes;
      }
      results.set(file.path, content);
    }
    return results;
  }

  let runningTotal = 0;
  const selectedShas: string[] = [];
  const selectedShaSet = new Set<string>();
  for (const file of candidates) {
    const size = sizes.get(file.sha);
    if (typeof size !== 'number' || size > maxBytes || runningTotal + size > maxTotalBytes) {
      results.set(file.path, null);
      continue;
    }
    if (!selectedShaSet.has(file.sha)) {
      selectedShaSet.add(file.sha);
      selectedShas.push(file.sha);
    }
    runningTotal += size;
  }
  if (selectedShas.length === 0) return results;

  let contentBySha = await batchBlobContents(dir, selectedShas, sizes, timeout);
  if (contentBySha.size === 0) {
    // Batch content read failed — recover with per-file cat-file for the
    // already-selected (budget-approved) blobs only.
    contentBySha = new Map();
    for (const file of candidates) {
      if (results.has(file.path)) continue;
      if (!selectedShaSet.has(file.sha)) continue;
      if (!contentBySha.has(file.sha)) {
        contentBySha.set(file.sha, await readTreeFile(dir, file, { maxBytes, timeoutMs: timeout }));
      }
      results.set(file.path, contentBySha.get(file.sha) ?? null);
    }
    return results;
  }

  for (const file of candidates) {
    if (results.has(file.path)) continue; // already resolved to null above
    results.set(file.path, contentBySha.get(file.sha) ?? null);
  }
  return results;
}

/** List (or reuse) the tracked file set for a pooled clone. Call while holding a shallowClone lease. */
export async function listCloneFiles(repo: string): Promise<{ files: ClonedFile[]; cached: boolean; dir: string; truncated: boolean }> {
  const lease = clonePool.get(repo);
  if (!lease) {
    throw new GitworthyError({
      code: 'git_clone_missing',
      message: `No pooled clone is available for ${repo}; call shallowClone first.`,
      not_checked: [`File list was not checked for ${repo}.`]
    });
  }
  if (lease.files) {
    return { files: lease.files, cached: true, dir: lease.dir, truncated: lease.treeTruncated === true };
  }
  const listed = await listTreeFiles(lease.dir);
  lease.files = listed.files;
  lease.treeTruncated = listed.truncated;
  lease.pathIndex = new Map(listed.files.map((entry) => [entry.path, entry]));
  return { files: listed.files, cached: false, dir: lease.dir, truncated: listed.truncated };
}

/**
 * Read one tracked file's content for a pooled clone. The path must already
 * appear in `listCloneFiles`'s output (a path allowlist derived from the
 * repo's own tree) — arbitrary or invented paths are refused, and symlink
 * entries are never followed.
 */
export async function readClonedFile(repo: string, filePath: string, opts: { maxBytes?: number } = {}): Promise<string | null> {
  const lease = clonePool.get(repo);
  if (!lease?.pathIndex) return null;
  const file = lease.pathIndex.get(filePath.replace(/\\/g, '/'));
  if (!file) return null;
  return readTreeFile(lease.dir, file, opts);
}

/**
 * Batched counterpart to `readClonedFile` for scanning many files at once
 * (e.g. content grep). Same path-allowlist and symlink rules apply; paths
 * missing from the pooled tree listing resolve to `null` in the result map.
 */
export async function readClonedFilesBatch(
  repo: string,
  filePaths: string[],
  opts: { maxBytes?: number; maxTotalBytes?: number } = {}
): Promise<Map<string, string | null>> {
  const lease = clonePool.get(repo);
  const results = new Map<string, string | null>();
  if (!lease?.pathIndex) {
    for (const filePath of filePaths) results.set(filePath, null);
    return results;
  }
  const files: ClonedFile[] = [];
  for (const filePath of filePaths) {
    const file = lease.pathIndex.get(filePath.replace(/\\/g, '/'));
    if (!file) {
      results.set(filePath, null);
      continue;
    }
    files.push(file);
  }
  const batch = await readTreeFilesBatch(lease.dir, files, opts);
  for (const file of files) results.set(file.path, batch.get(file.path) ?? null);
  return results;
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execa('git', args, { cwd, timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    return stdout;
  } catch {
    throw new GitworthyError({ code: 'git_command_failed', message: `git ${args.join(' ')} failed.`, not_checked: [`Git command failed: git ${args.join(' ')}.`] });
  }
}

/** True when `dir`'s origin remote looks like `owner/repo` on GitHub. */
export async function localCheckoutMatchesRepo(dir: string, repo: string): Promise<boolean> {
  try {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    const remote = stdout.trim().toLowerCase().replace(/\.git$/i, '');
    const needle = repo.trim().toLowerCase();
    return remote.endsWith(`/${needle}`) || remote.endsWith(`:${needle}`) || remote.includes(`github.com/${needle}`);
  } catch {
    return false;
  }
}

/** Test helper: drop in-memory git caches. */
export async function resetGitCachesForTests(): Promise<void> {
  headsCache.clear();
  cloneCreating.clear();
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
