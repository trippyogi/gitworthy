import { githubJson, GithubIssue } from '../lib/github.js';
import { createEnvelope, Envelope } from './envelope.js';

type Input = { repo: string; label?: string; keywords?: string[]; since?: string; limit?: number };

type Candidate = {
  number: number;
  title: string;
  labels: string[];
  age_days: number;
  comments: number;
  url: string;
  created_at: string;
  updated_at: string;
};

const TRACKER_LIMIT = 'scan reflects the issue tracker only; tracker state can lag branches, main, releases, duplicates, and maintainer intent, so scan results are not vetted contribution targets.';

function sinceToDate(since?: string): Date | null {
  if (!since) return null;
  const match = since.match(/^(\d+)(d|w|m)$/i);
  if (!match) return new Date(since);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const days = unit === 'd' ? amount : unit === 'w' ? amount * 7 : amount * 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function issueAgeDays(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / (24 * 60 * 60 * 1000)));
}

function matchesKeywords(issue: GithubIssue, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return true;
  const title = issue.title.toLowerCase();
  return keywords.some((keyword) => title.includes(keyword.toLowerCase()));
}

function matchesLabel(issue: GithubIssue, label: string | undefined): boolean {
  if (!label) return true;
  return issue.labels.some((item) => item.name.toLowerCase() === label.toLowerCase());
}

function candidate(issue: GithubIssue): Candidate {
  return {
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((label) => label.name),
    age_days: issueAgeDays(issue.created_at),
    comments: issue.comments,
    url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at
  };
}

export async function scan(input: Input): Promise<Envelope> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const query = new URLSearchParams({ state: 'open', per_page: '100', sort: 'updated', direction: 'desc' });
  if (input.label) query.set('labels', input.label);
  const issues = await githubJson<GithubIssue[]>(`/repos/${input.repo}/issues?${query.toString()}`);
  const sinceDate = sinceToDate(input.since);
  const candidates = issues
    .filter((issue) => !('pull_request' in issue))
    .filter((issue) => matchesLabel(issue, input.label))
    .filter((issue) => matchesKeywords(issue, input.keywords))
    .filter((issue) => !sinceDate || Date.parse(issue.created_at) >= sinceDate.getTime())
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
    .slice(0, limit)
    .map(candidate);
  return createEnvelope({
    verdict_summary: `found ${candidates.length} open issue ${candidates.length === 1 ? 'candidate' : 'candidates'} for tracker triage; scan does not vet them.`,
    evidence: candidates,
    checked: [`fetched open issues for ${input.repo}`, 'excluded pull requests', input.label ? `filtered by label: ${input.label}` : 'no label filter requested', input.keywords?.length ? `filtered titles by keywords: ${input.keywords.join(', ')}` : 'no keyword filter requested', input.since ? `filtered by created date since ${input.since}` : 'no age filter requested'],
    not_checked: [TRACKER_LIMIT],
    cached: false
  });
}
