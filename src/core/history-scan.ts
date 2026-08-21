/**
 * Bounded history scan (GW-050b). Runs only when the caller supplies paths, symbols, or terms.
 * Default helper uses argv-only git (no shell construction) against a matching local checkout.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { GitworthyError, createEnvelope, type Envelope } from './envelope.js';
import { GIT_SUBPROCESS_TIMEOUT_MS, localCheckoutMatchesRepo } from '../lib/git.js';
import { noteGitCommand } from '../lib/run-budget.js';
import { RepoRefSchema } from '../contracts/inputs.js';

export type HistoryHit = {
  sha: string;
  subject: string;
  paths: string[];
};

export type HistoryScanInput = {
  repo: string;
  paths?: string[];
  symbols?: string[];
  terms?: string[];
  limit?: number;
};

export type HistoryLogQuery = { repo: string; paths: string[]; grep: string[]; limit: number };

export type HistoryScanDeps = {
  log?: (input: HistoryLogQuery) => Promise<HistoryHit[]>;
};

const HISTORY_LIMIT = 20;
const MAX_BLAME_PATHS = 3;
const BLAME_LINE_CAP = 40;

export function normalizeHistoryPath(raw: string): string | null {
  const posix = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!posix || posix.length > 240) return null;
  if (posix.startsWith('/') || posix.startsWith('-') || posix.includes('\0')) return null;
  if (/^[A-Za-z]:/.test(posix)) return null;
  const parts = posix.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return posix;
}

export function sanitizeHistoryNeedle(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 80 || value.startsWith('-') || value.includes('\0')) return null;
  return value;
}

function parseLogLines(stdout: string, fallbackPath?: string): HistoryHit[] {
  const hits: HistoryHit[] = [];
  let current: HistoryHit | undefined;
  for (const line of stdout.split('\n')) {
    if (line.includes('\0')) {
      const [sha, subject = ''] = line.split('\0');
      if (!/^[0-9a-f]{7,40}$/i.test(sha ?? '')) continue;
      current = { sha, subject: subject.trim(), paths: fallbackPath ? [fallbackPath] : [] };
      hits.push(current);
      continue;
    }
    const file = line.trim();
    if (current && file && !file.includes('\0')) {
      const normalized = normalizeHistoryPath(file);
      if (normalized && !current.paths.includes(normalized)) current.paths.push(normalized);
    }
  }
  return hits;
}

async function gitLog(cwd: string, args: string[]): Promise<string> {
  noteGitCommand();
  const { stdout } = await execa('git', args, {
    cwd,
    timeout: GIT_SUBPROCESS_TIMEOUT_MS,
    reject: false
  });
  return stdout;
}

async function resolveHistoryCwd(repo: string): Promise<{ cwd: string; source: string; cleanup?: () => Promise<void> } | null> {
  const local = process.env.GITWORTHY_LOCAL_REPO?.trim();
  if (local && await localCheckoutMatchesRepo(local, repo)) {
    return { cwd: local, source: 'GITWORTHY_LOCAL_REPO' };
  }
  if (await localCheckoutMatchesRepo(process.cwd(), repo)) {
    return { cwd: process.cwd(), source: 'cwd' };
  }
  if (process.env.GITWORTHY_HISTORY_CLONE !== '1') return null;
  const parsed = RepoRefSchema.safeParse(repo);
  if (!parsed.success) return null;
  const dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-history-'));
  noteGitCommand();
  try {
    await execa('git', [
      'clone',
      '--depth',
      String(HISTORY_LIMIT),
      '--single-branch',
      `https://github.com/${parsed.data}.git`,
      dir
    ], { timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    return { cwd: dir, source: 'shallow_clone', cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

/** Argv-only git log / pickaxe / blame. Never interpolates into a shell string. */
export async function defaultHistoryLog(input: HistoryLogQuery): Promise<HistoryHit[]> {
  const paths = [...new Set(input.paths.map(normalizeHistoryPath).filter((item): item is string => Boolean(item)))];
  const grep = [...new Set(input.grep.map(sanitizeHistoryNeedle).filter((item): item is string => Boolean(item)))];
  if (paths.length === 0 && grep.length === 0) return [];
  const resolved = await resolveHistoryCwd(input.repo);
  if (!resolved) return [];
  const limit = String(Math.min(input.limit, HISTORY_LIMIT));
  const hits: HistoryHit[] = [];
  try {
    for (const file of paths) {
      const stdout = await gitLog(resolved.cwd, ['log', '-n', limit, '--format=%H%x00%s', '--name-only', '--', file]);
      hits.push(...parseLogLines(stdout, file));
    }
    for (const needle of grep) {
      const stdout = await gitLog(resolved.cwd, ['log', '-n', limit, `-S${needle}`, '--format=%H%x00%s', '--name-only']);
      hits.push(...parseLogLines(stdout));
    }
    for (const file of paths.slice(0, MAX_BLAME_PATHS)) {
      await gitLog(resolved.cwd, ['blame', '-L', `1,${BLAME_LINE_CAP}`, '--', file]);
    }
  } finally {
    if (resolved.cleanup) await resolved.cleanup();
  }
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.sha)) return false;
    seen.add(hit.sha);
    return true;
  }).slice(0, HISTORY_LIMIT);
}

export async function history_scan(input: HistoryScanInput, deps: HistoryScanDeps = {}): Promise<Envelope & { hits: HistoryHit[] }> {
  const rawPaths = input.paths ?? [];
  const rawSymbols = input.symbols ?? [];
  const rawTerms = input.terms ?? [];
  if (rawPaths.length === 0 && rawSymbols.length === 0 && rawTerms.length === 0) {
    throw new GitworthyError({
      code: 'history_scan_requires_query',
      message: 'history_scan requires at least one path, symbol, or term.',
      not_checked: ['History scan is not automatic for every issue.']
    });
  }
  const paths = rawPaths.map(normalizeHistoryPath).filter((item): item is string => Boolean(item));
  const symbols = rawSymbols.map(sanitizeHistoryNeedle).filter((item): item is string => Boolean(item));
  const terms = rawTerms.map(sanitizeHistoryNeedle).filter((item): item is string => Boolean(item));
  if (paths.length === 0 && symbols.length === 0 && terms.length === 0) {
    throw new GitworthyError({
      code: 'history_scan_invalid_query',
      message: 'history_scan rejected every supplied path, symbol, or term.',
      not_checked: ['Paths must be relative and cannot include .. or option-like tokens.']
    });
  }
  const limit = Math.min(input.limit ?? HISTORY_LIMIT, HISTORY_LIMIT);
  const helper = deps.log ?? defaultHistoryLog;
  const hits = await helper({ repo: input.repo, paths, grep: [...symbols, ...terms], limit });
  const usedDefault = !deps.log;
  return {
    ...createEnvelope({
      verdict_summary: hits.length === 0
        ? 'history scan found no matching commits in the bounded window.'
        : `history scan found ${hits.length} bounded commit hits.`,
      evidence: hits.map((hit) => ({ kind: 'history_hit', sha: hit.sha, subject: hit.subject, paths: hit.paths })),
      checked: [
        `bounded git history to ${limit} commits for supplied query`,
        usedDefault ? 'used argv-only git log / pickaxe / blame helper' : 'used the injected log helper'
      ],
      not_checked: [
        'History scan does not run unless the caller supplies paths, symbols, or terms.',
        'Patches were not inlined; only commit identity and paths are returned.',
        usedDefault && hits.length === 0
          ? 'No matching local checkout (GITWORTHY_LOCAL_REPO or cwd origin). Remote clone is opt-in via GITWORTHY_HISTORY_CLONE=1.'
          : usedDefault
            ? 'Used a matching local checkout; did not execute repository code.'
            : 'Used the injected log helper.'
      ]
    }),
    hits
  };
}
