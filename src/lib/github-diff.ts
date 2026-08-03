/** Fetch GitHub pull request unified diffs with byte budgets (GW-041). */

import { GitworthyError } from '../core/envelope.js';
import { githubApiHeaders, HttpClientError } from './http-client.js';
import {
  githubToken,
  githubHttpRequest,
  clearGithubCachesForTests,
  configureGithubHttpForTests
} from './github.js';
import {
  DEFAULT_MAX_DIFF_BYTES_PER_PR,
  tryConsumeBudget,
  type ContentionBudget
} from './contention-budget.js';

export type PullDiffResult = {
  text: string;
  bytes: number;
  truncated: boolean;
  additions?: number;
  deletions?: number;
  changed_files?: number;
};

/** @deprecated No-op; diffs use the shared GitHub client / replay transport. */
export function resetDiffHttpForTests(): void {
  // retained for call-site compatibility
}

export async function fetchPullDiff(
  repo: string,
  prNumber: number,
  budget: ContentionBudget,
  opts: { maxBytes?: number } = {}
): Promise<PullDiffResult> {
  const token = githubToken();
  if (!token) {
    throw new GitworthyError({
      code: 'missing_github_token',
      message: 'GITHUB_TOKEN is required for this GitHub API check.',
      not_checked: ['PR diff was not checked because GITHUB_TOKEN is missing.']
    });
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_DIFF_BYTES_PER_PR;
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  let response: Response;
  try {
    response = await githubHttpRequest(url, {
      headers: {
        ...githubApiHeaders(token),
        accept: 'application/vnd.github.diff'
      }
    });
  } catch (error) {
    if (error instanceof HttpClientError && error.code === 'http_timeout') {
      throw new GitworthyError({
        code: 'github_timeout',
        message: error.message,
        not_checked: [`PR diff timed out for ${repo}#${prNumber}.`]
      });
    }
    throw error;
  }

  if (!response.ok) {
    throw new GitworthyError({
      code: 'github_api_error',
      message: `GitHub diff request failed for ${repo}#${prNumber} with status ${response.status}.`,
      status: response.status,
      not_checked: [`PR diff was not checked for ${repo}#${prNumber}.`]
    });
  }

  const raw = await response.text();
  const capped = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  const consume = tryConsumeBudget(budget, Buffer.byteLength(capped, 'utf8'), `${repo}#${prNumber}.diff`);
  const text = consume.allowed < Buffer.byteLength(capped, 'utf8')
    ? capped.slice(0, Math.max(0, Math.floor(capped.length * (consume.allowed / Math.max(1, Buffer.byteLength(capped, 'utf8'))))))
    : capped;
  const truncated = consume.truncated || raw.length > maxBytes;
  const stats = summarizeDiff(text);
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated,
    ...stats
  };
}

export function summarizeDiff(diff: string): { additions: number; deletions: number; changed_files: number } {
  let additions = 0;
  let deletions = 0;
  let changed_files = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) changed_files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions, changed_files };
}

export function extractTouchedPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) {
      paths.add(match[2] === '/dev/null' ? match[1] : match[2]);
    }
  }
  return [...paths].sort();
}

/** Hunk-header + nearest definition heuristics (no tree-sitter in P1). */
export function extractTouchedSymbols(diff: string): string[] {
  const symbols = new Set<string>();
  let nearest: string | undefined;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ .+ @@\s*(.*)$/.exec(line);
    if (hunk?.[1]) {
      const header = hunk[1].trim();
      const def = firstDefinitionName(header);
      if (def) {
        nearest = def;
        symbols.add(def);
      }
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      const def = firstDefinitionName(line.slice(1));
      if (def) {
        nearest = def;
        symbols.add(def);
      } else if (nearest && (line.startsWith('+') || line.startsWith('-'))) {
        // keep nearest in set already
      }
    }
  }
  return [...symbols].sort();
}

function firstDefinitionName(line: string): string | undefined {
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=/,
    /\b(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_][\w]*)/,
    /\bdef\s+([A-Za-z_][\w]*)\s*\(/,
    /\bfunc\s+([A-Za-z_][\w]*)\s*\(/,
    /\bfn\s+([A-Za-z_][\w]*)\s*[<(]/
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

// Keep test helpers discoverable next to github overrides.
export { clearGithubCachesForTests, configureGithubHttpForTests };
