import { githubJson, GithubIssue } from '../lib/github.js';
import { loadCanonicalRepo, runSearchWithCanonicalRepo } from '../lib/repo.js';
import { isAutomationAuthor } from './bots.js';
import { lexicalOverlapScore, overlapTerms } from './candidate-quality.js';
import { GitworthyError } from './envelope.js';
import { createEnvelope, Envelope } from './envelope.js';
import { closesIssue, mentionsIssue } from './linkage.js';

type Input = { repo: string; issue_number: number };
type TimelineEvent = {
  event: string;
  created_at?: string;
  commit_id?: string | null;
  commit_url?: string | null;
  actor?: { login: string } | null;
  assignee?: { login: string } | null;
  source?: { type?: string; issue?: GithubIssue & { pull_request?: { url?: string; html_url?: string; merged_at?: string | null } } };
};
type GithubPr = { number: number; state: string; draft?: boolean; merged?: boolean; title: string; body?: string | null; html_url: string; user?: { login: string } | null; created_at: string; updated_at: string; closed_at: string | null; merged_at: string | null };
type IssueComment = { body: string | null; created_at: string; user?: { login: string } | null; html_url: string };
type SearchResult = { items: Array<GithubIssue & { pull_request?: { url?: string; html_url?: string; merged_at?: string | null }; body?: string | null; title?: string; repository_url?: string }> };
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
  repo?: string;
  referrer?: string;
  automation?: boolean;
  ignored_reason?: string;
  prior_attempt?: boolean;
  closed_at?: string | null;
  days_closed?: number | null;
  overlap_score?: number;
  shared_terms?: string[];
  closes_issue?: boolean;
};
type AssignmentEvidence = { kind: 'assignment'; assignee: string; assigned_at: string | null; assigned_by: string | null };
type ReferencedCommitEvidence = { kind: 'referenced_commit'; sha: string; date: string | null; url?: string; author: string | null };
type NetworkPrEvidence = {
  kind: 'network_pr';
  number: number;
  repo: string;
  state: string;
  merged: boolean;
  url: string;
  title: string;
  author: string | null;
  source: 'org_search';
};

const LINKAGE_LIMIT = 'PR linkage uses cross-references, explicit issue mentions (title+body), comment PR URLs, and high title overlap; renamed or differently worded work can still be missed. A secondary org-scoped search surfaces fork/other-repo PRs referencing the issue as density evidence only (never a SKIP signal by itself); it is lexical and scoped to the home repo\'s org, so PRs in forks under other orgs, or PRs that reference the issue without matching keywords, can still be missed.';
const TITLE_OVERLAP_MIN = 0.4;
const TITLE_OVERLAP_MIN_SHARED = 2;
const REFERENCED_COMMIT_CAP = 20;
const NETWORK_SEARCH_PER_PAGE = 20;
const CLAIM_COMMENT = /\b(i\s+('ve|have)\s+)?(submitted|opened|created|sent|made|raised)\s+(a\s+)?(pr|pull\s+request)\b|\b(pr|pull\s+request)\s+(is|was)\s+(up|ready|opened|submitted)\b|\bsee\s+(my\s+)?(pr|pull\s+request)\b/i;

const MAX_TIMELINE_PAGES = 2;

async function timeline(repo: string, issueNumber: number): Promise<{ events: TimelineEvent[]; truncated: boolean }> {
  const events: TimelineEvent[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_TIMELINE_PAGES; page += 1) {
    const pageEvents = await githubJson<TimelineEvent[]>(`/repos/${repo}/issues/${issueNumber}/timeline?per_page=100&page=${page}`);
    events.push(...pageEvents);
    if (pageEvents.length < 100) return { events, truncated };
    if (page === MAX_TIMELINE_PAGES) truncated = true;
  }
  return { events, truncated };
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

function prClosesIssue(pr: GithubPr, issueNumber: number): boolean {
  return closesIssue(`${pr.title}\n${pr.body ?? ''}`, issueNumber);
}

function linkedPrEvidence(pr: GithubPr, date: string, source: LinkedPrSource, issueNumber: number, extras: Partial<LinkedPrEvidence> = {}): LinkedPrEvidence {
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
    closes_issue: prClosesIssue(pr, issueNumber) || undefined,
    prior_attempt: prior_attempt || undefined,
    closed_at: prior_attempt ? pr.closed_at : undefined,
    days_closed: prior_attempt ? daysSince(pr.closed_at) : undefined,
    ...extras
  };
}

async function timelineLinkedPrs(homeRepo: string, events: TimelineEvent[], issueNumber: number): Promise<LinkedPrEvidence[]> {
  const prs = new Map<string, LinkedPrEvidence>();
  for (const event of events) {
    if (event.event !== 'cross-referenced' || event.source?.type !== 'issue' || !isPullRequestIssue(event.source.issue)) continue;
    // The cross-referenced PR may live in a different repo (fork/sibling); resolve its true home
    // from the timeline's own pull_request url/html_url instead of assuming homeRepo.
    const prRepo = repoFromPrRefs(event.source.issue.pull_request) ?? homeRepo;
    const pr = await prDetails(prRepo, event.source.issue.number);
    const key = prIdentityKey(prRepo, pr.number);
    prs.set(key, linkedPrEvidence(pr, event.created_at ?? pr.created_at, 'timeline', issueNumber, { repo: prRepo }));
  }
  return [...prs.values()].sort((left, right) => left.number - right.number);
}

function referencedCommits(events: TimelineEvent[]): { commits: ReferencedCommitEvidence[]; capped: boolean } {
  const seen = new Set<string>();
  const commits: ReferencedCommitEvidence[] = [];
  let capped = false;
  for (const event of events) {
    if (event.event !== 'referenced' || !event.commit_id) continue;
    if (seen.has(event.commit_id)) continue;
    seen.add(event.commit_id);
    commits.push({
      kind: 'referenced_commit',
      sha: event.commit_id,
      date: event.created_at ?? null,
      url: event.commit_url ?? undefined,
      author: event.actor?.login ?? null
    });
    if (commits.length >= REFERENCED_COMMIT_CAP) {
      capped = true;
      break;
    }
  }
  return { commits, capped };
}

/** Extracts an "owner/repo" full name from a Search API item's repository_url or html_url. */
function repoFromSearchItem(item: { repository_url?: string; html_url?: string }): string | null {
  if (item.repository_url) {
    const match = item.repository_url.match(/\/repos\/([^/]+\/[^/]+)$/);
    if (match) return match[1];
  }
  if (item.html_url) {
    const match = item.html_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i);
    if (match) return match[1];
  }
  return null;
}

/** Extracts an "owner/repo" full name from a pull request reference's API `url` (pulls) or `html_url`. */
function repoFromPrRefs(pr: { url?: string; html_url?: string } | null | undefined): string | null {
  if (!pr) return null;
  if (pr.url) {
    const match = pr.url.match(/\/repos\/([^/]+\/[^/]+)\/pulls\/\d+$/);
    if (match) return match[1];
  }
  if (pr.html_url) {
    const match = pr.html_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i);
    if (match) return match[1];
  }
  return null;
}

/** Case-insensitive "repo#number" identity key used to dedupe linked PR evidence across repos. */
function prIdentityKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

/**
 * Soft secondary pass: searches the home repo's org for open/closed PRs (in other repos, e.g. forks)
 * that reference the issue. This is density evidence only — never sufficient on its own to mark a PR
 * "linked" or force a SKIP, since a fork PR mentioning the issue number may be unrelated or abandoned.
 */
async function networkLinkedPrs(homeRepo: string, issueNumber: number): Promise<{ prs: NetworkPrEvidence[]; checked: string[]; not_checked: string[] }> {
  const owner = homeRepo.split('/')[0];
  if (!owner) {
    return { prs: [], checked: [], not_checked: ['network PR search skipped because the repository owner could not be determined from the input repo.'] };
  }
  try {
    // Prefer org: for organizations; fall back to user: for personal accounts (org: returns empty/error).
    let result: SearchResult | null = null;
    let scope: 'org' | 'user' = 'org';
    const issueClause = `is:pr ("Fixes #${issueNumber}" OR "Closes #${issueNumber}" OR "Resolves #${issueNumber}" OR "#${issueNumber}")`;
    try {
      const query = encodeURIComponent(`${issueClause} org:${owner}`);
      result = await githubJson<SearchResult>(`/search/issues?q=${query}&per_page=${NETWORK_SEARCH_PER_PAGE}`);
    } catch {
      scope = 'user';
      const query = encodeURIComponent(`${issueClause} user:${owner}`);
      result = await githubJson<SearchResult>(`/search/issues?q=${query}&per_page=${NETWORK_SEARCH_PER_PAGE}`);
    }
    // If org search succeeded but returned nothing, also try user: (personal namespace owners).
    if (scope === 'org' && (result?.items.length ?? 0) === 0) {
      try {
        const query = encodeURIComponent(`${issueClause} user:${owner}`);
        const userResult = await githubJson<SearchResult>(`/search/issues?q=${query}&per_page=${NETWORK_SEARCH_PER_PAGE}`);
        if (userResult.items.length > 0) {
          result = userResult;
          scope = 'user';
        }
      } catch {
        // keep empty org result
      }
    }
    const prs: NetworkPrEvidence[] = [];
    const seen = new Set<string>();
    for (const item of result?.items ?? []) {
      if (!('pull_request' in item)) continue;
      const itemRepo = repoFromSearchItem(item);
      if (!itemRepo || itemRepo.toLowerCase() === homeRepo.toLowerCase()) continue;
      const key = `${itemRepo.toLowerCase()}#${item.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pr = await maybePrDetails(itemRepo, item.number);
      if (!pr) continue;
      if (isAutomationAuthor(pr.user?.login)) continue;
      const text = `${pr.title}\n${pr.body ?? ''}`;
      if (!mentionsIssue(text, issueNumber)) continue;
      prs.push({
        kind: 'network_pr',
        number: pr.number,
        repo: itemRepo,
        state: pr.state,
        merged: pr.merged === true || pr.merged_at !== null,
        url: pr.html_url,
        title: pr.title,
        author: pr.user?.login ?? null,
        source: 'org_search'
      });
    }
    return {
      prs,
      checked: [`searched ${scope}:${owner} for network/fork pull requests referencing #${issueNumber}`],
      not_checked: []
    };
  } catch {
    return {
      prs: [],
      checked: [],
      not_checked: [`network pull request search for owner ${owner} failed; fork/sibling PRs may be under-counted.`]
    };
  }
}

function timelineCapabilityNotes(events: TimelineEvent[]): { checked: string[]; not_checked: string[] } {
  const types = new Set(events.map((event) => event.event));
  const checked = [`timeline events observed: ${events.length === 0 ? 'none' : [...types].sort().join(', ')}`];
  const not_checked: string[] = [];
  const hasCrossRef = types.has('cross-referenced');
  const hasOtherActivity = [...types].some((type) => type !== 'cross-referenced' && type !== 'assigned' && type !== 'unassigned');
  if (!hasCrossRef && (hasOtherActivity || events.length > 0)) {
    not_checked.push(
      'timeline returned no cross-referenced events; some tokens omit PR cross-links from the timeline API, so prior PRs may be under-counted — prefer a classic PAT or fine-grained token with Issues: Read, or rely on search/title linkage.'
    );
  }
  return { checked, not_checked };
}

async function searchLinkedPrs(repo: string, issueNumber: number, existing: Set<string>): Promise<{ prs: LinkedPrEvidence[]; checked: string[]; not_checked: string[] }> {
  const { result, context } = await runSearchWithCanonicalRepo(repo, async (fullName) => {
    const query = encodeURIComponent(`repo:${fullName} is:pr ${issueNumber}`);
    return githubJson<SearchResult>(`/search/issues?q=${query}&per_page=20`);
  });
  // Prefer URLs / Search canonical name over the caller alias so renamed repos share one identity key.
  const homeRepo = context.full_name;
  const prs = [] as LinkedPrEvidence[];
  for (const item of result.items) {
    const itemRepo = repoFromSearchItem(item) ?? repoFromPrRefs(item.pull_request) ?? homeRepo;
    const key = prIdentityKey(itemRepo, item.number);
    if (!('pull_request' in item) || existing.has(key)) continue;
    const pr = await prDetails(itemRepo, item.number);
    const text = `${item.title ?? pr.title}\n${item.body ?? pr.body ?? ''}`;
    if (!mentionsIssue(text, issueNumber)) continue;
    prs.push(linkedPrEvidence(pr, pr.created_at, 'search', issueNumber, { repo: itemRepo }));
    existing.add(key);
  }
  return {
    prs: prs.sort((left, right) => left.number - right.number),
    checked: [...context.checked, 'matched search hits against issue number in PR title and body'],
    not_checked: context.not_checked
  };
}

type CommentPrRef = { repo: string; number: number };

/**
 * Finds pull request references in a comment body. Explicit "github.com/owner/repo/pull/N" links
 * carry their own repo identity (which may differ from the home repo, e.g. a fork PR). Bare
 * "PR #N" / "pull #N" mentions are ambiguous and default to the home repo.
 */
function commentPrRefs(homeRepo: string, body: string): CommentPrRef[] {
  const refs = new Map<string, CommentPrRef>();
  for (const match of body.matchAll(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/gi)) {
    const number = Number(match[2]);
    if (!Number.isInteger(number)) continue;
    const repo = match[1];
    refs.set(prIdentityKey(repo, number), { repo, number });
  }
  for (const match of body.matchAll(/(?:pull request|pull|pr)\s*#(\d+)/gi)) {
    const number = Number(match[1]);
    if (!Number.isInteger(number)) continue;
    const key = prIdentityKey(homeRepo, number);
    if (!refs.has(key)) refs.set(key, { repo: homeRepo, number });
  }
  return [...refs.values()];
}

async function commentLinkedPrs(apiRepo: string, issueNumber: number, existing: Set<string>): Promise<{ prs: LinkedPrEvidence[]; claimComments: boolean }> {
  const comments = await githubJson<IssueComment[]>(`/repos/${apiRepo}/issues/${issueNumber}/comments?per_page=100`);
  const prs = [] as LinkedPrEvidence[];
  let claimComments = false;
  for (const comment of comments) {
    const body = comment.body ?? '';
    if (CLAIM_COMMENT.test(body)) claimComments = true;
    for (const ref of commentPrRefs(apiRepo, body)) {
      const key = prIdentityKey(ref.repo, ref.number);
      if (existing.has(key)) continue;
      const pr = await maybePrDetails(ref.repo, ref.number);
      if (!pr) continue;
      existing.add(key);
      prs.push(linkedPrEvidence(pr, comment.created_at, 'comment', issueNumber, { referrer: comment.html_url, repo: ref.repo }));
    }
  }
  return { prs: prs.sort((left, right) => left.number - right.number), claimComments };
}

async function titleOverlapPrs(
  repo: string,
  issue: GithubIssue,
  existing: Set<string>,
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
  const homeRepo = context.full_name;
  const issueText = `${issue.title}\n${issue.body ?? ''}`;
  const prs = [] as LinkedPrEvidence[];
  const minScore = force ? Math.min(TITLE_OVERLAP_MIN, 0.32) : TITLE_OVERLAP_MIN;
  const minShared = TITLE_OVERLAP_MIN_SHARED;
  for (const item of result.items) {
    const itemRepo = repoFromSearchItem(item) ?? repoFromPrRefs(item.pull_request) ?? homeRepo;
    const key = prIdentityKey(itemRepo, item.number);
    if (!('pull_request' in item) || existing.has(key) || item.number === issue.number) continue;
    const pr = await prDetails(itemRepo, item.number);
    if (isAutomationAuthor(pr.user?.login)) continue;
    const { score, shared } = lexicalOverlapScore(issueText, `${pr.title}\n${pr.body ?? item.body ?? ''}`);
    if (score < minScore || shared.length < minShared) continue;
    prs.push(linkedPrEvidence(pr, pr.created_at, 'title_overlap', issue.number, { overlap_score: Number(score.toFixed(3)), shared_terms: shared, repo: itemRepo }));
    existing.add(key);
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
  // Prefer the resolved full_name for home-repo identity so alias inputs (renames) match
  // timeline/search URL-derived keys instead of double-counting the same PR.
  const homeRepo = resolved.full_name;
  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const { events, truncated: timelineTruncated } = await timeline(input.repo, input.issue_number);
  const timelineNotes = timelineCapabilityNotes(events);
  const timelinePrs = await timelineLinkedPrs(homeRepo, events, input.issue_number);
  const { commits, capped: commitsCapped } = referencedCommits(events);
  const knownPrs = new Set(timelinePrs.map((pr) => prIdentityKey(pr.repo ?? homeRepo, pr.number)));
  const { prs: commentPrs, claimComments } = await commentLinkedPrs(homeRepo, input.issue_number, knownPrs);
  const { prs: searchPrs, checked: searchChecked, not_checked: searchNotChecked } = await searchLinkedPrs(input.repo, input.issue_number, knownPrs);
  const hasHumanLinked = [...timelinePrs, ...commentPrs, ...searchPrs].some((pr) => !isAutomationAuthor(pr.author));
  const shouldTitleSearch = claimComments || !hasHumanLinked;
  const titleResult = shouldTitleSearch
    ? await titleOverlapPrs(input.repo, issue, knownPrs, claimComments)
    : { prs: [], checked: [], not_checked: ['title-overlap PR search skipped because explicit linkage already covered the issue.'] };
  // Soft secondary pass, always run (capped per_page) — surfaces fork/other-repo PRs as density
  // evidence only; never treated as a linked_pr and never forces a SKIP signal on its own.
  const { prs: networkPrs, checked: networkChecked, not_checked: networkNotChecked } = await networkLinkedPrs(homeRepo, input.issue_number);
  const { active, ignored } = partitionLinkedPrs([...timelinePrs, ...commentPrs, ...searchPrs, ...titleResult.prs]);
  const linkedPrs = active.sort((left, right) => left.number - right.number);
  const assignments = assignmentEvidence(issue, events);
  const priorAttempts = linkedPrs.filter((pr) => pr.prior_attempt).length;
  const signals = [
    ...(linkedPrs.some((pr) => pr.state === 'open') ? ['linked_pr_open' as const] : []),
    ...(linkedPrs.some((pr) => pr.merged) ? ['linked_pr_merged' as const] : []),
    ...(linkedPrs.some((pr) => pr.state === 'closed' && !pr.merged) ? ['linked_pr_closed' as const] : []),
    ...(assignments.length > 0 ? ['assigned' as const] : [])
  ];
  const linkedLabel = linkedPrs.length === 1 ? 'linked pull request' : 'linked pull requests';
  const assignedLabel = assignments.length === 1 ? 'assignee' : 'assignees';
  const checkedNotes = [...new Set([...resolved.checked, ...searchChecked, ...titleResult.checked, ...timelineNotes.checked, ...networkChecked])];
  const notCheckedNotes = [...new Set([...resolved.not_checked, ...searchNotChecked, ...titleResult.not_checked, ...timelineNotes.not_checked, ...networkNotChecked, LINKAGE_LIMIT])];
  if (timelineTruncated) {
    notCheckedNotes.push(`timeline soft-capped at ${MAX_TIMELINE_PAGES} pages; older cross-references may be missing.`);
  }
  if (ignored.length > 0) {
    checkedNotes.push(`ignored ${ignored.length} automation-authored pull request${ignored.length === 1 ? '' : 's'} for verdict signals`);
  }
  if (commits.length > 0) {
    checkedNotes.push(`collected ${commits.length} referenced commit${commits.length === 1 ? '' : 's'} from timeline (evidence only; commits do not force SKIP)`);
  }
  if (commitsCapped) {
    notCheckedNotes.push(`referenced commits capped at ${REFERENCED_COMMIT_CAP}; older referenced commits may be omitted.`);
  }
  if (networkPrs.length > 0) {
    checkedNotes.push(`found ${networkPrs.length} cross-repository pull request${networkPrs.length === 1 ? '' : 's'} in the org referencing this issue (evidence only; does not force a linked-PR signal)`);
  }
  if (claimComments && linkedPrs.every((pr) => pr.source !== 'title_overlap' && pr.source !== 'comment')) {
    notCheckedNotes.push('a comment claimed a pull request was submitted, but no matching PR was linked; read recent open PRs manually.');
  }
  const densityBits = [
    priorAttempts > 0 ? `${priorAttempts} prior closed unmerged PR${priorAttempts === 1 ? '' : 's'}` : null,
    commits.length > 0 ? `${commits.length} referenced commit${commits.length === 1 ? '' : 's'}` : null,
    networkPrs.length > 0 ? `${networkPrs.length} network/fork PR${networkPrs.length === 1 ? '' : 's'} referencing the issue` : null
  ].filter(Boolean);
  const verdict_summary = linkedPrs.length > 0 || assignments.length > 0
    ? `found ${linkedPrs.length} ${linkedLabel} and ${assignments.length} ${assignedLabel}${densityBits.length ? ` (${densityBits.join(', ')})` : ''}.`
    : ignored.length > 0
      ? `no human-linked pull requests or assignees found (${ignored.length} automation PR${ignored.length === 1 ? '' : 's'} ignored)${densityBits.length ? `; ${densityBits.join(', ')}` : ''}.`
      : densityBits.length > 0
        ? `no linked pull requests or assignees; found ${densityBits.join(', ')}.`
        : 'no linked pull requests or current assignees found.';
  const evidence = [...linkedPrs, ...ignored, ...assignments, ...commits, ...networkPrs];
  return createEnvelope({
    verdict_summary,
    evidence,
    signals,
    checked: [
      `fetched issue ${input.repo}#${input.issue_number}`,
      ...checkedNotes,
      'fetched issue timeline cross-reference, referenced commits, and assignment events',
      'fetched issue comments for pull request references',
      'searched pull requests for explicit issue-number mentions in title and body',
      'searched org-wide for cross-repository (fork/network) pull requests referencing the issue'
    ],
    not_checked: notCheckedNotes,
    cached: false
  });
}
