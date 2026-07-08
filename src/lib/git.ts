import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { GitworthyError } from '../core/envelope.js';

export type RemoteHead = { name: string; sha: string };

export async function lsRemoteHeads(repo: string): Promise<RemoteHead[]> {
  const remote = `https://github.com/${repo}.git`;
  try {
    const { stdout } = await execa('git', ['ls-remote', '--heads', remote]);
    return stdout.split('\n').filter(Boolean).map((line) => {
      const [sha, ref] = line.split(/\s+/);
      return { sha, name: ref.replace('refs/heads/', '') };
    });
  } catch {
    throw new GitworthyError({ code: 'git_ls_remote_failed', message: `git ls-remote failed for ${repo}.`, not_checked: [`Remote heads were not checked for ${repo}.`] });
  }
}

export async function shallowClone(repo: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-'));
  try {
    await execa('git', ['clone', '--depth', '1', `https://github.com/${repo}.git`, dir]);
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch {
    await rm(dir, { recursive: true, force: true });
    throw new GitworthyError({ code: 'git_clone_failed', message: `git shallow clone failed for ${repo}.`, not_checked: [`Repository tree was not checked for ${repo}.`] });
  }
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execa('git', args, { cwd });
    return stdout;
  } catch {
    throw new GitworthyError({ code: 'git_command_failed', message: `git ${args.join(' ')} failed.`, not_checked: [`Git command failed: git ${args.join(' ')}.`] });
  }
}
