import { githubJson, GithubIssue } from '../lib/github.js';
import { loadCanonicalRepo, runSearchWithCanonicalRepo } from '../lib/repo.js';
import { GitworthyError } from './envelope.js';
import { createEnvelope, Envelope } from './envelope.js';

type Input = { repo: string; issue_number: number };
type TimelineEvent = {
  event: string;
  created_at?: string;
  actor?: { login: string } | null;
  assignee?: { login: string } | null;
  source?: { type?: string; issue?: GithubIssue & { pull_request?: { url?: string; html_url?: string; merged_at?: string | null } } };
};
type GithubPr = { number: number; state: string; draft?: boolean; merged?: boolean; title: string; html_url: string; user?: { login: string } | null; created_at: string; updated_at: string; closed_at: string | null; merged_at: string | null };
type IssueComment = { body: string | null; created_at: string; user?: { login: string } | null; html_url: string };
type SearchResult = { items: Array<GithubIssue & { pull_request?: { url?: string; html_url?: string } }> };
type LinkedPrEvidence = { kind: 'linked_pr'; number: number; state: string; draft: boolean; merged: boolean; date: string; author: string | null; title: string; url: string; source: 'timeline' | 'search' | 'comment'; referrer?: string };
type AssignmentEvidence = { kind: 'assignment'; assignee: string; assigned_at: string | null; assigned_by: string | null };

const LINKAGE_LIMIT = 'PR linkage depends on GitHub cross-reference events or explicit issue-number mentions; a PR that never mentions the issue number remains invisible.';

async function timeline(repo: string, issueNumber: number): Promise<TimelineEvent[]> {
  const events: TimelineEvent[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const pageEvents = await githubJson<TimelineEvent[]>(`/repos/${repo}/issues/${issueNumber}/timeline?per_page=100&page=${page}`);
    events.push(...pageEvents);
    if (pageEvents.length < 100) break;
  }
  return events;
}

async function prDetails(repo: string, issueNumber: number): Promise<GithubPr> {
  return githubJson<GithubPr>(`/repos/${repo}/pulls/${issueNumber}`);
}

async function maybePrDetails(repo: string, issueNumber: number): Promise<GithubPr | null> {
  try {
    return await prDetails(repo, issueNumber);
  } catch (error) {
    if (error instanceof GitworthyError && error.status === 404) return null;
    throw error;
  }
}

function isPullRequestIssue(issue: unknown): issue is GithubIssue & { pull_request: { url?: string; html_url?: string; merged_at?: string | null } } {
  return typeof issue === 'object' && issue !== null && 'pull_request' in issue;
}

function linkedPrEvidence(pr: GithubPr, date: string, source: 'timeline' | 'search' | 'comment', referrer?: string): LinkedPrEvidence {
  return { kind: 'linked_pr', number: pr.number, state: pr.state, draft: pr.draft === true, merged: pr.merged === true || pr.merged_at !== null, date, author: pr.user?.login ?? null, title: pr.title, url: pr.html_url, source, referrer };
}

async function timelineLinkedPrs(repo: string, events: TimelineEvent[]): Promise<LinkedPrEvidence[]> {
  const prs = new Map<number, LinkedPrEvidence>();
  for (const event of events) {
    if (event.event !== 'cross-referenced' || event.source?.type !== 'issue' || !isPullRequestIssue(event.source.issue)) continue;
    const pr = await prDetails(repo, event.source.issue.number);
    prs.set(pr.number, linkedPrEvidence(pr, event.created_at ?? pr.created_at, 'timeline'));
  }
  return [...prs.values()].sort((left, right) => left.number - right.number);
}

async function searchLinkedPrs(repo: string, apiRepo: string, issueNumber: number, existing: Set<number>): Promise<{ prs: LinkedPrEvidence[]; checked: string[]; not_checked: string[] }> {
  const { result, context } = await runSearchWithCanonicalRepo(repo, async (fullName) => {
    const query = encodeURIComponent(`repo:${fullName} is:pr ${issueNumber}`);
    return githubJson<SearchResult>(`/search/issues?q=${query}&per_page=20`);
  });
  const prs = [] as LinkedPrEvidence[];
  for (const item of result.items) {
    if (!('pull_request' in item) || existing.has(item.number)) continue;
    const pr = await prDetails(apiRepo, item.number);
    const body = item.body ?? '';
    if (!new RegExp(`(?:#|issues/)${issueNumber}(?:\\D|$)`, 'i').test(body)) continue;
    prs.push(linkedPrEvidence(pr, pr.created_at, 'search'));
    existing.add(item.number);
  }
  return { prs: prs.sort((left, right) => left.number - right.number), checked: context.checked, not_checked: context.not_checked };
}

function commentPrNumbers(repos: string[], body: string): number[] {
  const numbers = new Set<number>();
  for (const repo of new Set(repos.filter(Boolean))) {
    const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of body.matchAll(new RegExp(`github\\.com/${escapedRepo}/pull/(\\d+)`, 'gi'))) numbers.add(Number(match[1]));
  }
  for (const match of body.matchAll(/(?:pull request|pull|pr)\s*#(\d+)/gi)) numbers.add(Number(match[1]));
  return [...numbers].filter((number) => Number.isInteger(number));
}

async function commentLinkedPrs(canonicalRepo: string, apiRepo: string, issueNumber: number, existing: Set<number>): Promise<LinkedPrEvidence[]> {
  const comments = await githubJson<IssueComment[]>(`/repos/${apiRepo}/issues/${issueNumber}/comments?per_page=100`);
  const prs = [] as LinkedPrEvidence[];
  for (const comment of comments) {
    for (const number of commentPrNumbers([canonicalRepo, apiRepo], comment.body ?? '')) {
      if (existing.has(number)) continue;
      const pr = await maybePrDetails(apiRepo, number);
      if (!pr) continue;
      existing.add(number);
      prs.push(linkedPrEvidence(pr, comment.created_at, 'comment', comment.html_url));
    }
  }
  return prs.sort((left, right) => left.number - right.number);
}

function assignmentEvidence(issue: GithubIssue, events: TimelineEvent[]): AssignmentEvidence[] {
  const assignmentDates = new Map<string, { assigned_at: string; assigned_by: string | null }>();
  for (const event of events) {
    if (event.event !== 'assigned' || !event.assignee?.login || !event.created_at) continue;
    assignmentDates.set(event.assignee.login, { assigned_at: event.created_at, assigned_by: event.actor?.login ?? null });
  }
  return (issue.assignees ?? []).map((assignee) => {
    const assigned = assignmentDates.get(assignee.login);
    return { kind: 'assignment', assignee: assignee.login, assigned_at: assigned?.assigned_at ?? null, assigned_by: assigned?.assigned_by ?? null };
  });
}

export async function linked_work(input: Input): Promise<Envelope> {
  const resolved = await loadCanonicalRepo(input.repo);
  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const events = await timeline(input.repo, input.issue_number);
  const timelinePrs = await timelineLinkedPrs(input.repo, events);
  const knownPrs = new Set(timelinePrs.map((pr) => pr.number));
  const commentPrs = await commentLinkedPrs(resolved.full_name, input.repo, input.issue_number, knownPrs);
  const { prs: searchPrs, checked: searchChecked, not_checked: searchNotChecked } = await searchLinkedPrs(input.repo, input.repo, input.issue_number, knownPrs);
  const linkedPrs = [...timelinePrs, ...commentPrs, ...searchPrs].sort((left, right) => left.number - right.number);
  const assignments = assignmentEvidence(issue, events);
  const signals = [
    ...(linkedPrs.some((pr) => pr.state === 'open') ? ['linked_pr_open' as const] : []),
    ...(linkedPrs.some((pr) => pr.merged) ? ['linked_pr_merged' as const] : []),
    ...(linkedPrs.some((pr) => pr.state === 'closed' && !pr.merged) ? ['linked_pr_closed' as const] : []),
    ...(assignments.length > 0 ? ['assigned' as const] : [])
  ];
  const linkedLabel = linkedPrs.length === 1 ? 'linked pull request' : 'linked pull requests';
  const assignedLabel = assignments.length === 1 ? 'assignee' : 'assignees';
  const checkedNotes = [...new Set([...resolved.checked, ...searchChecked])];
  const notCheckedNotes = [...new Set([...resolved.not_checked, ...searchNotChecked, LINKAGE_LIMIT])];
  return createEnvelope({
    verdict_summary: linkedPrs.length > 0 || assignments.length > 0 ? `found ${linkedPrs.length} ${linkedLabel} and ${assignments.length} ${assignedLabel}.` : 'no linked pull requests or current assignees found.',
    evidence: [...linkedPrs, ...assignments],
    signals,
    checked: [`fetched issue ${input.repo}#${input.issue_number}`, ...checkedNotes, 'fetched issue timeline cross-reference and assignment events', 'fetched issue comments for pull request references', 'searched pull requests for explicit issue-number mentions'],
    not_checked: notCheckedNotes,
    cached: false
  });
}
