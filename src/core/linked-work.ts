import { githubJson, GithubIssue } from '../lib/github.js';
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
type SearchResult = { items: Array<GithubIssue & { pull_request?: { url?: string; html_url?: string } }> };
type LinkedPrEvidence = { kind: 'linked_pr'; number: number; state: string; draft: boolean; merged: boolean; date: string; author: string | null; title: string; url: string; source: 'timeline' | 'search' };
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

function isPullRequestIssue(issue: unknown): issue is GithubIssue & { pull_request: { url?: string; html_url?: string; merged_at?: string | null } } {
  return typeof issue === 'object' && issue !== null && 'pull_request' in issue;
}

function linkedPrEvidence(pr: GithubPr, date: string, source: 'timeline' | 'search'): LinkedPrEvidence {
  return { kind: 'linked_pr', number: pr.number, state: pr.state, draft: pr.draft === true, merged: pr.merged === true || pr.merged_at !== null, date, author: pr.user?.login ?? null, title: pr.title, url: pr.html_url, source };
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

async function searchLinkedPrs(repo: string, issueNumber: number, existing: Set<number>): Promise<LinkedPrEvidence[]> {
  const query = encodeURIComponent(`repo:${repo} is:pr ${issueNumber}`);
  const result = await githubJson<SearchResult>(`/search/issues?q=${query}&per_page=20`);
  const prs = [] as LinkedPrEvidence[];
  for (const item of result.items) {
    if (!('pull_request' in item) || existing.has(item.number)) continue;
    const pr = await prDetails(repo, item.number);
    const body = item.body ?? '';
    if (!new RegExp(`(?:#|issues/)${issueNumber}(?:\\D|$)`, 'i').test(body)) continue;
    prs.push(linkedPrEvidence(pr, pr.created_at, 'search'));
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
  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const events = await timeline(input.repo, input.issue_number);
  const timelinePrs = await timelineLinkedPrs(input.repo, events);
  const searchPrs = await searchLinkedPrs(input.repo, input.issue_number, new Set(timelinePrs.map((pr) => pr.number)));
  const linkedPrs = [...timelinePrs, ...searchPrs].sort((left, right) => left.number - right.number);
  const assignments = assignmentEvidence(issue, events);
  const signals = [
    ...(linkedPrs.some((pr) => pr.state === 'open') ? ['linked_pr_open' as const] : []),
    ...(linkedPrs.some((pr) => pr.merged) ? ['linked_pr_merged' as const] : []),
    ...(assignments.length > 0 ? ['assigned' as const] : [])
  ];
  const linkedLabel = linkedPrs.length === 1 ? 'linked pull request' : 'linked pull requests';
  const assignedLabel = assignments.length === 1 ? 'assignee' : 'assignees';
  return createEnvelope({
    verdict_summary: linkedPrs.length > 0 || assignments.length > 0 ? `found ${linkedPrs.length} ${linkedLabel} and ${assignments.length} ${assignedLabel}.` : 'no linked pull requests or current assignees found.',
    evidence: [...linkedPrs, ...assignments],
    signals,
    checked: [`fetched issue ${input.repo}#${input.issue_number}`, 'fetched issue timeline cross-reference and assignment events', 'searched pull requests for explicit issue-number mentions'],
    not_checked: [LINKAGE_LIMIT],
    cached: false
  });
}
