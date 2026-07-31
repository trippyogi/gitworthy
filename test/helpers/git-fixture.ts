import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

/** Create a throwaway local git repo used as a stand-in for a real bare clone in tests. */
export async function initGitFixture(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['config', 'user.email', 'test@gitworthy.local'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'gitworthy-test'], { cwd: dir });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Write and commit a set of plain text files (relative path -> content). */
export async function commitFixtureFiles(dir: string, files: Record<string, string>, message = 'fixture commit'): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const full = path.join(dir, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', message], { cwd: dir });
}

/**
 * Add a symlink-mode (120000) tree entry without relying on OS-level symlink
 * support, so the test works the same on Windows/macOS/Linux and models a
 * hostile repo that ships a real symlink blob.
 */
export async function commitSymlinkBlob(dir: string, relativePath: string, target: string, message = 'add symlink entry'): Promise<void> {
  const { stdout } = await execa('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: target });
  const sha = stdout.trim();
  await execa('git', ['update-index', '--add', '--cacheinfo', `120000,${sha},${relativePath}`], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', message], { cwd: dir });
}
