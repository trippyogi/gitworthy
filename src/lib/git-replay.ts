/** Git probe replay from versioned provider fixtures (GW-022). */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import {
  type GitFixtureProbe,
  type ProviderFixturePack,
  ProviderFixturePackSchema
} from '../contracts/provider-fixtures.js';
import { GitworthyError } from '../core/envelope.js';
import { type GitEvalHooks, type RemoteHead, GIT_SUBPROCESS_TIMEOUT_MS, registerEvalCloneLease, unregisterEvalCloneLease } from './git.js';
import { ProviderReplayError } from './provider-replay.js';

type QueuedProbe = { probe: GitFixtureProbe; consumed: boolean };

export type GitReplaySession = {
  hooks: GitEvalHooks;
  assertExhausted: () => void;
  unused: () => GitFixtureProbe[];
  cleanup: () => Promise<void>;
};

export function createGitReplaySession(pack: ProviderFixturePack): GitReplaySession {
  const parsed = ProviderFixturePackSchema.parse(pack);
  const queues = new Map<string, QueuedProbe[]>();
  const materialized = new Map<string, string>();
  const cleanups: Array<() => Promise<void>> = [];

  for (const probe of [...parsed.git_probes].sort((a, b) => a.sequence - b.sequence)) {
    const key = gitMatchKey(probe);
    const list = queues.get(key) ?? [];
    list.push({ probe, consumed: false });
    queues.set(key, list);
  }

  function take(kind: GitFixtureProbe['kind'], repo: string, extra?: { ref?: string; path?: string }): GitFixtureProbe {
    const key = gitMatchKey({ kind, match: { repo, ref: extra?.ref, path: extra?.path } });
    const queue = queues.get(key);
    const next = queue?.find((item) => !item.consumed);
    if (!next) {
      throw new ProviderReplayError(
        'replay_unexpected_git_probe',
        `Unexpected git probe during replay: ${kind} ${repo}`,
        { kind, repo, ref: extra?.ref, path: extra?.path }
      );
    }
    next.consumed = true;
    return next.probe;
  }

  const hooks: GitEvalHooks = {
    lsRemoteHeads: async (repo: string): Promise<RemoteHead[]> => {
      const probe = take('ls_remote_heads', repo);
      if (probe.response.error === 'ls_remote_failed') {
        throw new GitworthyError({
          code: 'git_ls_remote_failed',
          message: `git ls-remote failed for ${repo}.`,
          not_checked: [`Remote heads were not checked for ${repo}.`]
        });
      }
      return probe.response.heads ?? [];
    },
    shallowClone: async (repo: string) => {
      const probe = take('shallow_clone', repo);
      if (probe.response.error === 'clone_failed') {
        throw new GitworthyError({
          code: 'git_clone_failed',
          message: `git shallow clone failed for ${repo}.`,
          not_checked: [`Repository tree was not checked for ${repo}.`]
        });
      }
      let dir = materialized.get(repo);
      if (!dir) {
        const files = probe.response.files ?? [];
        dir = await materializeBareRepo(files);
        materialized.set(repo, dir);
        registerEvalCloneLease(repo, dir);
        cleanups.push(async () => {
          await rm(dir!, { recursive: true, force: true }).catch(() => undefined);
          unregisterEvalCloneLease(repo);
        });
      } else {
        registerEvalCloneLease(repo, dir);
      }
      return {
        dir,
        cached: false,
        cleanup: async () => undefined
      };
    }
  };

  return {
    hooks,
    unused: () => [...queues.values()].flatMap((items) => items.filter((item) => !item.consumed).map((item) => item.probe)),
    assertExhausted: () => {
      const leftover = [...queues.values()].flatMap((items) => items.filter((item) => !item.consumed));
      // list_tree / read_tree_file probes are optional metadata for future runners;
      // only require exhaustion of network-facing probes.
      const required = leftover.filter((item) => item.probe.kind === 'ls_remote_heads' || item.probe.kind === 'shallow_clone');
      if (required.length === 0) return;
      throw new ProviderReplayError(
        'replay_unused_git_fixtures',
        `Replay left ${required.length} unused git fixture(s).`,
        {
          unused: required.map((item) => ({
            sequence: item.probe.sequence,
            kind: item.probe.kind,
            repo: item.probe.match.repo
          }))
        }
      );
    },
    cleanup: async () => {
      for (const fn of cleanups.reverse()) await fn();
      materialized.clear();
    }
  };
}

function gitMatchKey(probe: { kind: string; match: { repo: string; ref?: string; path?: string } }): string {
  return [probe.kind, probe.match.repo.toLowerCase(), probe.match.ref ?? '', probe.match.path ?? ''].join('\n');
}

async function materializeBareRepo(files: Array<{ path: string; content: string; symlink?: boolean }>): Promise<string> {
  const work = await mkdtemp(path.join(tmpdir(), 'gitworthy-replay-work-'));
  const bare = await mkdtemp(path.join(tmpdir(), 'gitworthy-replay-bare-'));
  try {
    await execa('git', ['init'], { cwd: work, timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    await execa('git', ['config', 'user.email', 'replay@gitworthy.local'], { cwd: work, timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    await execa('git', ['config', 'user.name', 'gitworthy-replay'], { cwd: work, timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    for (const file of files) {
      if (file.symlink) continue;
      const full = path.join(work, file.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, file.content);
    }
    if (files.length === 0) {
      await writeFile(path.join(work, '.gitworthy-empty'), `${createHash('sha256').update(bare).digest('hex')}\n`);
    }
    await execa('git', ['add', '-A'], { cwd: work, timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    await execa('git', ['commit', '-m', 'replay fixture'], { cwd: work, timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    await rm(bare, { recursive: true, force: true });
    await execa('git', ['clone', '--bare', work, bare], { timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    return bare;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
