import { githubJson, GithubIssue } from '../lib/github.js';
import { createEnvelope, Envelope } from './envelope.js';

const DUPE_LIMIT = 'lexical similarity only; semantic duplicates with different vocabulary will be missed.';
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'should', 'would', 'could', 'please', 'issue']);

type Input = { repo: string; issue_number: number; max_candidates?: number };

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((token) => !STOP.has(token)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = Array.from(a).filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function sharedErrorPhrase(a: string, b: string): boolean {
  const quoted = Array.from(a.matchAll(/"([^"]{8,})"/g)).map((match) => match[1].toLowerCase());
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  return quoted.some((phrase) => lowerB.includes(phrase)) || (lowerA.includes('npx is not available') && lowerB.includes('npx is not available'));
}

export async function dupe_cluster(input: Input): Promise<Envelope> {
  const target = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const targetTokens = tokens(`${target.title} ${target.body ?? ''}`.slice(0, 600));
  const distinctive = Array.from(tokens(target.title)).slice(0, 5);
  const query = encodeURIComponent(`repo:${input.repo} is:issue ${distinctive.join(' ')}`);
  const searched = await githubJson<{ items: GithubIssue[] }>(`/search/issues?q=${query}&per_page=${input.max_candidates ?? 50}`);
  const listed = [] as GithubIssue[];
  const pages = input.max_candidates ? 1 : 3;
  for (let page = 1; page <= pages; page += 1) {
    listed.push(...await githubJson<GithubIssue[]>(`/repos/${input.repo}/issues?state=all&per_page=${input.max_candidates ?? 100}&page=${page}`));
  }
  const byNumber = new Map<number, GithubIssue>();
  for (const issue of [...searched.items, ...listed]) if (issue.number !== target.number) byNumber.set(issue.number, issue);
  const targetText = `${target.title} ${target.body ?? ''}`.slice(0, 600);
  const candidates = Array.from(byNumber.values()).map((issue) => {
    const issueText = `${issue.title} ${issue.body ?? ''}`.slice(0, 600);
    const score = Math.max(jaccard(targetTokens, tokens(issueText)), sharedErrorPhrase(targetText, issueText) ? 0.5 : 0);
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      closed: issue.state === 'closed',
      url: issue.html_url,
      score: Number(score.toFixed(3))
    };
  }).filter((candidate) => candidate.score >= 0.35).sort((a, b) => b.score - a.score);
  return createEnvelope({
    verdict_summary: candidates.length > 0 ? `${candidates.length} lexical duplicate ${candidates.length === 1 ? 'candidate' : 'candidates'} found.` : 'no lexical duplicate candidates found.',
    evidence: candidates,
    signals: candidates.length > 0 ? ['duplicate'] : [],
    checked: [`fetched target issue ${input.repo}#${input.issue_number}`, 'searched GitHub issues by distinctive title tokens', 'scored open issues by lexical overlap'],
    not_checked: [DUPE_LIMIT],
    cached: false
  });
}
