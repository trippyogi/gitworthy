import { githubJson, GithubIssue } from '../lib/github.js';
import { loadCanonicalRepo, runSearchWithCanonicalRepo } from '../lib/repo.js';
import { isAutomationAuthor } from './bots.js';
import { lexicalOverlapScore, overlapTerms } from './candidate-quality.js';
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
type GithubPr = { number: number; state: string; draft?: boolean; merged?: boolean; title: string; body?: string | null; html_url: string; user?: { login: string } | null; created_at: string; updated_at: string; closed_at: string | null; merged_at: string | null };
type IssueComment = { body: string | null; created_at: string; user?: { login: string } | null; html_url: string };
type SearchResult = { items: Array<GithubIssue & { pull_request?: { url?: string; html_url?: string }; body?: string | null }> };
type LinkedPrSource = 'timeline' | 'search' | 'comment' | 'title_overlap';
type LinkedPrEvidence = {
  kind: 'linked_pr';
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  date: string;
  author: string | null;
  title: string;
  url: string;
  source: LinkedPrSource;
  referrer?: string;
  automation?: boolean;
  ignored_reason?: string;
  prior_attempt?: boolean;
  closed_at?: string | null;
  days_closed?: number | null;
  overlap_score?: number;
  shared_terms?: string[];
};
type AssignmentEvidence = { kind: 'assignment'; assignee: string; assigned_at: string | null; assigned_by: string | null };

const LINKAGE_LIMIT = 'PR linkage uses cross-references, explicit issue mentions, comment PR URLs, and high title overlap; renamed or differently worded work can still be missed. Fork-only PRs are invisible.';
const TITLE_OVERLAP_MIN = 0.4;
const TITLE_OVERLAP_MIN_SHARED = 2;
const CLAIM_COMMENT = /\b(i\s+('ve|have)\s+)?(submitted|opened|created|sent|made|raised)\s+(a\s+)?(pr|pull\s+request)\b|\b(pr|pull\s+request)\s+(is|was)\s+(up|ready|opened|submitted)\b|\bsee\s+(my\s+)?(pr|pull\s+request)\b/i;

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

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000)));
}

function linkedPrEvidence(pr: GithubPr, date: string, source: LinkedPrSource, extras: Partial<LinkedPrEvidence> = {}): LinkedPrEvidence {
  const merged = pr.merged === true || pr.merged_at !== null;
  const prior_attempt = pr.state === 'closed' && !merged;
  return {
    kind: 'linked_pr',
    number: pr.number,
    state: pr.state,
    draft: pr.draft === true,
    merged,
    date,
    author: pr.user?.login ?? null,
    title: pr.title,
    url: pr.html_url,
    source,
    prior_attempt: prior_attempt || undefined,
    closed_at: prior_attempt ? pr.closed_at : undefined,
    days_closed: prior_attempt ? daysSince(pr.closed_at) : undefined,
    ...extras
  };
}

function mentionsIssue(body: string, issueNumber: number): boolean {
  const closing = new RegExp(`(?:fix(?:es)?|close[sd]?|resolve[sd]?|addresses|related\\s+to)\\s+(?:#|https?:\\/\\/github\\.com\\/[^/]+\\/[^/]+\\/issues\\/)${issueNumber}\\b`, 'i');
  if (closing.test(body)) return true;
  return new RegExp(`(?:^|[\\s(,\\[])(?:#|issues\\/)${issueNumber}\\b`).test(body);
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
    const body = item.body ?? pr.body ?? '';
    if (!mentionsIssue(body, issueNumber)) continue;
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

async function commentLinkedPrs(canonicalRepo: string, apiRepo: string, issueNumber: number, existing: Set<number>): Promise<{ prs: LinkedPrEvidence[]; claimComments: boolean }> {
  const comments = await githubJson<IssueComment[]>(`/repos/${apiRepo}/issues/${issueNumber}/comments?per_page=100`);
  const prs = [] as LinkedPrEvidence[];
  let claimComments = false;
  for (const comment of comments) {
    const body = comment.body ?? '';
    if (CLAIM_COMMENT.test(body)) claimComments = true;
    for (const number of commentPrNumbers([canonicalRepo, apiRepo], body)) {
      if (existing.has(number)) continue;
      const pr = await maybePrDetails(apiRepo, number);
      if (!pr) continue;
      existing.add(number);
      prs.push(linkedPrEvidence(pr, comment.created_at, 'comment', { referrer: comment.html_url }));
    }
  }
  return { prs: prs.sort((left, right) => left.number - right.number), claimComments };
}

async function titleOverlapPrs(
  repo: string,
  apiRepo: string,
  issue: GithubIssue,
  existing: Set<number>,
  force: boolean
): Promise<{ prs: LinkedPrEvidence[]; checked: string[]; not_checked: string[] }> {
  const terms = overlapTerms(issue.title, 5);
  if (terms.length < 2) {
    return {
      prs: [],
      checked: [],
      not_checked: [
        force
          ? 'title-overlap PR search skipped because the issue title lacked enough distinctive terms (claim comment alone is not enough to search all open PRs).'
          : 'title-overlap PR search skipped because the issue title lacked enough distinctive terms.'
      ]
    };
  }
  const searchTerms = terms.slice(0, 3).join(' ');
  const { result, context } = await runSearchWithCanonicalRepo(repo, async (fullName) => {
    const query = encodeURIComponent(`repo:${fullName} is:pr is:open ${searchTerms}`);
    return githubJson<SearchResult>(`/search/issues?q=${query}&per_page=20`);
  });
  const issueText = `${issue.title}\n${issue.body ?? ''}`;
  const prs = [] as LinkedPrEvidence[];
  const minScore = force ? Math.min(TITLE_OVERLAP_MIN, 0.32) : TITLE_OVERLAP_MIN;
  const minShared = TITLE_OVERLAP_MIN_SHARED;
  for (const item of result.items) {
    if (!('pull_request' in item) || existing.has(item.number) || item.number === issue.number) continue;
    const pr = await prDetails(apiRepo, item.number);
    if (isAutomationAuthor(pr.user?.login)) continue;
    const { score, shared } = lexicalOverlapScore(issueText, `${pr.title}\n${pr.body ?? item.body ?? ''}`);
    if (score < minScore || shared.length < minShared) continue;
    prs.push(linkedPrEvidence(pr, pr.created_at, 'title_overlap', { overlap_score: Number(score.toFixed(3)), shared_terms: shared }));
    existing.add(item.number);
  }
  return {
    prs: prs.sort((left, right) => left.number - right.number),
    checked: [...context.checked, `searched open pull requests for title overlap with terms: ${searchTerms}`],
    not_checked: context.not_checked
  };
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

function partitionLinkedPrs(prs: LinkedPrEvidence[]): { active: LinkedPrEvidence[]; ignored: LinkedPrEvidence[] } {
  const active: LinkedPrEvidence[] = [];
  const ignored: LinkedPrEvidence[] = [];
  for (const pr of prs) {
    if (isAutomationAuthor(pr.author)) {
      ignored.push({ ...pr, automation: true, ignored_reason: 'automation_author' });
    } else {
      active.push(pr);
    }
  }
  return { active, ignored };
}

export async function linked_work(input: Input): Promise<Envelope> {
  const resolved = await loadCanonicalRepo(input.repo);
  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const events = await timeline(input.repo, input.issue_number);
  const timelinePrs = await timelineLinkedPrs(input.repo, events);
  const knownPrs = new Set(timelinePrs.map((pr) => pr.number));
  const { prs: commentPrs, claimComments } = await commentLinkedPrs(resolved.full_name, input.repo, input.issue_number, knownPrs);
  const { prs: searchPrs, checked: searchChecked, not_checked: searchNotChecked } = await searchLinkedPrs(input.repo, input.repo, input.issue_number, knownPrs);
  const hasHumanLinked = [...timelinePrs, ...commentPrs, ...searchPrs].some((pr) => !isAutomationAuthor(pr.author));
  const shouldTitleSearch = claimComments || !hasHumanLinked;
  const titleResult = shouldTitleSearch
    ? await titleOverlapPrs(input.repo, input.repo, issue, knownPrs, claimComments)
    : { prs: [], checked: [], not_checked: ['title-overlap PR search skipped because explicit linkage already covered the issue.'] };
  const { active, ignored } = partitionLinkedPrs([...timelinePrs, ...commentPrs, ...searchPrs, ...titleResult.prs]);
  const linkedPrs = active.sort((left, right) => left.number - right.number);
  const assignments = assignmentEvidence(issue, events);
  const signals = [
    ...(linkedPrs.some((pr) => pr.state === 'open') ? ['linked_pr_open' as const] : []),
    ...(linkedPrs.some((pr) => pr.merged) ? ['linked_pr_merged' as const] : []),
    ...(linkedPrs.some((pr) => pr.state === 'closed' && !pr.merged) ? ['linked_pr_closed' as const] : []),
    ...(assignments.length > 0 ? ['assigned' as const] : [])
  ];
  const linkedLabel = linkedPrs.length === 1 ? 'linked pull request' : 'linked pull requests';
  const assignedLabel = assignments.length === 1 ? 'assignee' : 'assignees';
  const checkedNotes = [...new Set([...resolved.checked, ...searchChecked, ...titleResult.checked])];
  const notCheckedNotes = [...new Set([...resolved.not_checked, ...searchNotChecked, ...titleResult.not_checked, LINKAGE_LIMIT])];
  if (ignored.length > 0) {
    checkedNotes.push(`ignored ${ignored.length} automation-authored pull request${ignored.length === 1 ? '' : 's'} for verdict signals`);
  }
  if (claimComments && linkedPrs.every((pr) => pr.source !== 'title_overlap' && pr.source !== 'comment')) {
    notCheckedNotes.push('a comment claimed a pull request was submitted, but no matching PR was linked; read recent open PRs manually.');
  }
  const evidence = [...linkedPrs, ...ignored, ...assignments];
  return createEnvelope({
    verdict_summary: linkedPrs.length > 0 || assignments.length > 0
      ? `found ${linkedPrs.length} ${linkedLabel} and ${assignments.length} ${assignedLabel}.`
      : ignored.length > 0
        ? `no human-linked pull requests or assignees found (${ignored.length} automation PR${ignored.length === 1 ? '' : 's'} ignored).`
        : 'no linked pull requests or current assignees found.',
    evidence,
    signals,
    checked: [
      `fetched issue ${input.repo}#${input.issue_number}`,
      ...checkedNotes,
      'fetched issue timeline cross-reference and assignment events',
      'fetched issue comments for pull request references',
      'searched pull requests for explicit issue-number mentions'
    ],
    not_checked: notCheckedNotes,
    cached: false
  });
}
