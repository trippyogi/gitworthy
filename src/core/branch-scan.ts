import { readCache, writeCache } from '../lib/cache.js';
import { githubJson } from '../lib/github.js';
import { lsRemoteHeads } from '../lib/git.js';
import { createEnvelope, Envelope, GitworthyError } from './envelope.js';
import { isGenericTerm, normalizeTerm } from './terms.js';

const TTL = 15 * 60 * 1000;
const LIMIT_BRANCH = 'fork branches are invisible to this remote branch scan.';
const LIMIT_MATCH = 'branch name matching is lexical and can miss renamed or differently named work.';
const BROAD_BRANCH_TERMS = new Set(['agent', 'agents', 'domain', 'domains']);

type Input = { repo: string; keywords: string[]; max_age_days?: number; force_refresh?: boolean };
type CommitInfo = { date?: string; subject?: string; url?: string };

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

function branchMatches(branch: string, keywords: string[]): boolean {
  const tokens = branchTokens(branch);
  const hits = keywords.filter((keyword) => tokens.has(keyword));
  if (hits.length >= 2) return true;
  if (hits.length === 0) return false;
  return keywords.length === 1 && !isBroadBranchTerm(hits[0] ?? '');
}

export async function branch_scan(input: Input): Promise<Envelope> {
  const cached = await readCache<Envelope>('branch_scan', input, TTL, input.force_refresh);
  if (cached.hit) return { ...cached.value, cached: true, fetched_at: cached.fetched_at };
  const fetched_at = new Date().toISOString();
  const heads = await lsRemoteHeads(input.repo);
  const keywords = normalizedKeywords(input.keywords);
  const matches = heads.filter((head) => branchMatches(head.name, keywords));
  const evidence = [] as Array<Record<string, unknown>>;
  const not_checked = [LIMIT_BRANCH, LIMIT_MATCH];
  for (const match of matches) {
    let commit: CommitInfo = {};
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
    evidence.push({ branch: match.name, sha: match.sha, url: `https://github.com/${input.repo}/tree/${encodeURIComponent(match.name)}`, ...commit });
  }
  const maxAge = input.max_age_days ?? 45;
  const now = Date.now();
  const recent = evidence.some((item) => typeof item.date === 'string' && now - Date.parse(item.date) <= maxAge * 24 * 60 * 60 * 1000);
  const branchLabel = matches.length === 1 ? 'branch' : 'branches';
  const verdict_summary = matches.length === 0 ? 'no matching remote branches found.' : recent ? `recent in-flight work found in ${matches.length} matching ${branchLabel}.` : `${matches.length} matching ${branchLabel} found, but no recent token-verified activity was established.`;
  const envelope = createEnvelope({ verdict_summary: verdict_summary.trim(), evidence, signals: recent ? ['in_flight'] : [], checked: [`listed remote heads for ${input.repo}`, `matched branch names against keywords: ${input.keywords.join(', ')}`], not_checked, cached: false, fetched_at });
  await writeCache('branch_scan', input, envelope, fetched_at);
  return envelope;
}
