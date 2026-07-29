import { readCache, writeCache } from '../lib/cache.js';
import { githubJson } from '../lib/github.js';
import { lsRemoteHeads } from '../lib/git.js';
import { createEnvelope, Envelope, GitworthyError } from './envelope.js';
import { isGenericTerm, normalizeTerm } from './terms.js';

const TTL = 15 * 60 * 1000;
const LIMIT_BRANCH = 'fork branches are invisible to this remote branch scan.';
const LIMIT_MATCH = 'branch name matching is lexical and can miss renamed or differently named work.';
const MAX_MATCHES = 15;
const MAX_COMMIT_FETCHES = 8;
const BROAD_BRANCH_TERMS = new Set([
  'agent', 'agents', 'domain', 'domains',
  'proxy', 'model', 'models', 'docs', 'doc', 'documentation',
  'fix', 'bug', 'feat', 'feature', 'update', 'improve', 'improvement',
  'langgraph', 'langchain', 'typescript', 'python', 'react', 'sdk', 'api',
  'cli', 'web', 'app', 'core', 'server', 'client', 'tool', 'tools',
  'support', 'handle', 'enable', 'disable', 'refactor', 'chore', 'misc',
  'test', 'tests', 'patch', 'hotfix', 'wip', 'temp', 'tmp', 'dev', 'main',
  'master', 'release', 'version', 'bump', 'deps', 'dependency', 'dependencies',
  'channel', 'channels', 'message', 'messages', 'session', 'sessions', 'telegram', 'discord', 'slack'
]);

type Input = { repo: string; keywords: string[]; issue_number?: number; max_age_days?: number; force_refresh?: boolean; max_matches?: number; max_commit_fetches?: number };
type CommitInfo = { date?: string; subject?: string; url?: string };
type RankedMatch = { name: string; sha: string; score: number; match_reason: 'issue_number' | 'keyword' };

function branchTokens(branch: string): Set<string> {
  return new Set((branch.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).map(normalizeTerm));
}

function normalizedKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const keyword of keywords) {
    const raw = keyword.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];
    for (const term of raw) {
      const normalized = normalizeTerm(term);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      terms.push(normalized);
    }
  }
  return terms;
}

function isBroadBranchTerm(term: string): boolean {
  return isGenericTerm(term) || BROAD_BRANCH_TERMS.has(term);
}

function branchMentionsIssue(branch: string, issueNumber: number | undefined): boolean {
  if (!issueNumber) return false;
  // Require an issue-like token (fix-123, issue/123, #123) — bare digits match semver segments.
  return new RegExp(`(?:^|[^a-z0-9])(?:(?:fix|issue|pr|gh)[-_/]?|#)${issueNumber}(?:[^0-9]|$)`, 'i').test(branch);
}

function matchScore(branch: string, keywords: string[], issueNumber?: number): RankedMatch | null {
  if (branchMentionsIssue(branch, issueNumber)) {
    return { name: branch, sha: '', score: 100, match_reason: 'issue_number' };
  }
  const tokens = branchTokens(branch);
  const hits = keywords.filter((keyword) => tokens.has(keyword));
  if (hits.length === 0) return null;
  const specificHits = hits.filter((hit) => !isBroadBranchTerm(hit));
  if (hits.length >= 2 && specificHits.length >= 1) {
    return { name: branch, sha: '', score: 40 + specificHits.length * 10 + hits.length, match_reason: 'keyword' };
  }
  const only = hits[0] ?? '';
  if (isBroadBranchTerm(only) || only.length < 5) return null;
  return { name: branch, sha: '', score: 20 + only.length, match_reason: 'keyword' };
}

export function branchMatches(branch: string, keywords: string[], issueNumber?: number): boolean {
  return matchScore(branch, keywords, issueNumber) !== null;
}

export async function branch_scan(input: Input): Promise<Envelope> {
  const cached = await readCache<Envelope>('branch_scan', input, TTL, input.force_refresh);
  if (cached.hit) return { ...cached.value, cached: true, fetched_at: cached.fetched_at };
  const fetched_at = new Date().toISOString();
  const heads = await lsRemoteHeads(input.repo, input.force_refresh === true);
  const keywords = normalizedKeywords(input.keywords);
  const maxMatches = Math.min(Math.max(input.max_matches ?? MAX_MATCHES, 1), 50);
  const maxCommitFetches = Math.min(Math.max(input.max_commit_fetches ?? MAX_COMMIT_FETCHES, 0), maxMatches);
  const ranked = heads
    .map((head) => {
      const scored = matchScore(head.name, keywords, input.issue_number);
      if (!scored) return null;
      return { ...scored, sha: head.sha };
    })
    .filter((item): item is RankedMatch => item !== null)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  const totalMatches = ranked.length;
  const matches = ranked.slice(0, maxMatches);
  const evidence = [] as Array<Record<string, unknown>>;
  const not_checked = [LIMIT_BRANCH, LIMIT_MATCH];
  if (totalMatches > matches.length) {
    not_checked.push(`capped branch evidence at ${maxMatches} of ${totalMatches} lexical matches (prefer issue-number and higher-score hits).`);
  }
  for (const [index, match] of matches.entries()) {
    let commit: CommitInfo = {};
    if (index < maxCommitFetches) {
      try {
        const data = await githubJson<{ commit: { author: { date: string }; message: string }; html_url: string }>(`/repos/${input.repo}/commits/${match.sha}`);
        commit = { date: data.commit.author.date, subject: data.commit.message.split('\n')[0], url: data.html_url };
      } catch (error) {
        if (error instanceof GitworthyError && error.code === 'missing_github_token') {
          not_checked.push(`tip commit metadata for ${match.name} was not checked because GITHUB_TOKEN is missing.`);
        } else {
          not_checked.push(`tip commit metadata for ${match.name} was not checked because the GitHub API request failed.`);
        }
      }
    }
    evidence.push({
      branch: match.name,
      sha: match.sha,
      url: `https://github.com/${input.repo}/tree/${encodeURIComponent(match.name)}`,
      match_reason: match.match_reason,
      match_score: match.score,
      ...commit
    });
  }
  if (matches.length > maxCommitFetches) {
    not_checked.push(`tip commit metadata fetched for ${maxCommitFetches} of ${matches.length} capped matches.`);
  }
  const maxAge = input.max_age_days ?? 45;
  const now = Date.now();
  const recentByDate = evidence.some((item) => typeof item.date === 'string' && now - Date.parse(item.date) <= maxAge * 24 * 60 * 60 * 1000);
  // Issue-number branch hits are strong enough to count as in_flight even when commit dates were not fetched.
  const recent = recentByDate || evidence.some((item) => item.match_reason === 'issue_number');
  const shown = matches.length;
  const branchLabel = shown === 1 ? 'branch' : 'branches';
  const verdict_summary = shown === 0
    ? 'no matching remote branches found.'
    : recent
      ? `recent in-flight work found in ${shown} matching ${branchLabel}${totalMatches > shown ? ` (of ${totalMatches} lexical hits)` : ''}.`
      : `${shown} matching ${branchLabel} found${totalMatches > shown ? ` (of ${totalMatches} lexical hits)` : ''}, but no recent tip activity was established among fetched commits.`;
  const envelope = createEnvelope({
    verdict_summary: verdict_summary.trim(),
    evidence,
    signals: recent ? ['in_flight'] : [],
    checked: [
      `listed remote heads for ${input.repo}`,
      `matched branch names against keywords: ${input.keywords.join(', ')}${input.issue_number ? ` (issue #${input.issue_number})` : ''}`,
      `capped branch evidence at ${maxMatches} matches and ${maxCommitFetches} tip-commit fetches`
    ],
    not_checked,
    cached: false,
    fetched_at
  });
  await writeCache('branch_scan', input, envelope, fetched_at);
  return envelope;
}
