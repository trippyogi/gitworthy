import { githubJson, GithubIssue } from '../lib/github.js';
import { readCache } from '../lib/cache.js';
import { runSearchWithCanonicalRepo } from '../lib/repo.js';
import {
  createDiscoveryBudget,
  discoveryCanFetchPage,
  discoveryNotePage,
  discoveryNoteRequest,
  emptyFilterCounts,
  shortlistWithBackfill,
  toDiscoveryMeta,
  type DiscoveryMeta,
  type FilterCounts
} from '../lib/discovery-budget.js';
import { noteCandidatesConsidered, notePagesFetched } from '../lib/run-budget.js';
import { isAutomationAuthor } from './bots.js';
import { assessIssueQuality } from './candidate-quality.js';
import { createEnvelope, Envelope } from './envelope.js';
import { mentionsIssue } from './linkage.js';
import {
  compareRanked,
  explainRankingLines,
  rankCandidate,
  RANKING_VERSION,
  type RankingWeights
} from './rank.js';
import { resolveSkillProfile, scoreSkillFit, SkillProfile } from './skill-fit.js';

type Input = {
  repo: string;
  label?: string;
  keywords?: string[];
  since?: string;
  limit?: number;
  land_hints?: boolean;
  skill_profile?: SkillProfile | string;
  /** Max issue list pages (default 1 — preserves prior one-page behavior). */
  max_pages?: number;
  explain_ranking?: boolean;
  ranking_weights?: Partial<RankingWeights>;
};

export type Candidate = {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
  age_days: number;
  comments: number;
  url: string;
  created_at: string;
  updated_at: string;
  quality_score: number;
  quality_reasons: string[];
  repro: 'present' | 'weak' | 'missing';
  soft_ask: boolean;
  likely_land_only?: boolean;
  land_hint?: string;
  fit_score?: number;
  fit_reasons?: string[];
  fit_matched?: string[];
  fit_avoided?: string[];
  availability_hint_score?: number;
  rank_score?: number;
  ranking_version?: string;
  ranking_explain?: string[];
};

type RepoHints = { language?: string | null; topics?: string[]; description?: string | null };

type OpenPrSearchItem = {
  number: number;
  title?: string;
  body?: string | null;
  html_url: string;
  user?: { login?: string } | null;
  pull_request?: { url?: string; html_url?: string };
};
type OpenPrSearchResult = { items: OpenPrSearchItem[] };

const TRACKER_LIMIT = 'scan reflects the issue tracker only; tracker state can lag branches, main, releases, duplicates, and maintainer intent, so scan results are not vetted contribution targets. quality_score ranks tracker attractiveness only.';
const CONTRIB_POLICY_TTL = 24 * 60 * 60 * 1000;
const OPEN_PR_SEARCH_PER_PAGE = 30;

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
  const haystack = `${issue.title}\n${issue.body ?? ''}`.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function matchesLabel(issue: GithubIssue, label: string | undefined): boolean {
  if (!label) return true;
  return issue.labels.some((item) => item.name.toLowerCase() === label.toLowerCase());
}

function candidate(issue: GithubIssue): Candidate {
  const quality = assessIssueQuality({
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((label) => label.name),
    assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
    comments: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at
  });
  return {
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((label) => label.name),
    assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
    age_days: issueAgeDays(issue.created_at),
    comments: issue.comments,
    url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    quality_score: quality.score,
    quality_reasons: quality.reasons,
    repro: quality.repro,
    soft_ask: quality.soft_ask
  };
}

async function fetchRepoHints(repo: string): Promise<RepoHints | undefined> {
  try {
    const data = await githubJson<{ language?: string | null; topics?: string[]; description?: string | null }>(`/repos/${repo}`);
    return { language: data.language ?? null, topics: data.topics ?? [], description: data.description ?? null };
  } catch {
    return undefined;
  }
}

function applySkillFit(issues: GithubIssue[], candidates: Candidate[], profile: SkillProfile, repoHints: RepoHints | undefined): void {
  issues.forEach((issue, index) => {
    const item = candidates[index];
    if (!item) return;
    const fit = scoreSkillFit({
      profile,
      issue: { title: issue.title, body: issue.body, labels: item.labels },
      repoHints
    });
    item.fit_score = fit.score;
    item.fit_reasons = fit.reasons;
    item.fit_matched = fit.matched;
    item.fit_avoided = fit.avoided;
  });
}

async function cachedPolicyHint(repo: string): Promise<{ checked: string[]; not_checked: string[] }> {
  const cached = await readCache<Envelope>('contrib_policy', { repo }, CONTRIB_POLICY_TTL);
  if (!cached.hit) return { checked: [], not_checked: [`policy hint unavailable: run gitworthy policy ${repo} before investing in an unfamiliar repo.`] };
  const checked: string[] = [];
  if (cached.value.signals.includes('no_pr_path')) {
    const evidence = cached.value.evidence.find((item) => item.category === 'no_pr_path' && typeof item.feedback_channel === 'string');
    const channel = typeof evidence?.feedback_channel === 'string' ? evidence.feedback_channel : 'not stated';
    checked.push(`policy hint: cached contrib_policy says repo accepts no pull requests; feedback channel: ${channel}`);
  } else {
    checked.push('policy hint: cached contrib_policy found no no-PR path signal');
  }
  if (cached.value.signals.includes('claim_required')) {
    checked.push('policy hint: cached contrib_policy requires claiming/assignment before opening a PR');
  }
  return { checked, not_checked: [] };
}

type WidenHint = {
  kind: 'widen_hint';
  reason: string;
  suggestions: string[];
};

function widenHintEvidence(input: Input, candidates: Candidate[], limit: number): WidenHint | null {
  if (!input.label) return null;
  const threshold = Math.min(5, limit);
  const allAssigned = candidates.length > 0 && candidates.every((item) => item.assignees.length > 0);
  const thin = candidates.length < threshold;
  if (!thin && !allAssigned) return null;
  const appliedFilters = [
    `label "${input.label}"`,
    ...(input.keywords?.length ? [`keywords ${input.keywords.join(',')}`] : []),
    ...(input.since ? [`since ${input.since}`] : [])
  ];
  const filterPhrase = appliedFilters.join(', ');
  const reasons: string[] = [];
  if (thin) reasons.push(`only ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} after ${filterPhrase} (below ${threshold})`);
  if (allAssigned) reasons.push('every remaining candidate is assigned');
  const suggestions = [
    'drop the label filter and scan again',
    'try label "help wanted"',
    'scan without a label for broader tracker triage',
    'try quieter sibling keywords or a less contested label'
  ];
  if (input.keywords?.length) suggestions.unshift('drop or relax the keyword filter and scan again');
  if (input.since) suggestions.unshift('widen or drop the --since age filter and scan again');
  return {
    kind: 'widen_hint',
    reason: reasons.join('; '),
    suggestions
  };
}

async function applyLandHints(repo: string, candidates: Candidate[]): Promise<{ checked: string[]; not_checked: string[] }> {
  for (const item of candidates) {
    if (item.assignees.length > 0) {
      item.likely_land_only = true;
      item.land_hint = `assigned: ${item.assignees[0]}`;
    }
  }
  if (candidates.length === 0) return { checked: [], not_checked: [] };
  if (candidates.every((item) => item.likely_land_only)) {
    return { checked: ['all candidates already assigned; skipped open PR search for land-only hints'], not_checked: [] };
  }
  const byNumber = new Map(candidates.map((item) => [item.number, item]));
  try {
    const { result, context } = await runSearchWithCanonicalRepo(repo, async (fullName) => {
      const query = encodeURIComponent(`repo:${fullName} is:pr is:open`);
      return githubJson<OpenPrSearchResult>(`/search/issues?q=${query}&per_page=${OPEN_PR_SEARCH_PER_PAGE}`);
    });
    for (const pr of result.items) {
      if (isAutomationAuthor(pr.user?.login)) continue;
      const text = `${pr.title ?? ''}\n${pr.body ?? ''}`;
      for (const [number, item] of byNumber) {
        if (item.likely_land_only) continue;
        if (mentionsIssue(text, number)) {
          item.likely_land_only = true;
          item.land_hint = `open PR #${pr.number} ${pr.html_url}`;
        }
      }
    }
    return { checked: [...context.checked, 'checked open pull requests for land-only hints (assignees + human PR title/body issue references)'], not_checked: context.not_checked };
  } catch {
    return { checked: [], not_checked: [`land-only hints via open PR search were not checked for ${repo} because the search request failed.`] };
  }
}

async function fetchIssuePages(input: {
  repo: string;
  label?: string;
  budget: ReturnType<typeof createDiscoveryBudget>;
}): Promise<{ issues: GithubIssue[]; partial: boolean; partialReason?: string }> {
  const issues: GithubIssue[] = [];
  let partial = false;
  let partialReason: string | undefined;
  for (let page = 1; discoveryCanFetchPage(input.budget); page += 1) {
    const query = new URLSearchParams({
      state: 'open',
      per_page: '100',
      sort: 'updated',
      direction: 'desc',
      page: String(page)
    });
    if (input.label) query.set('labels', input.label);
    discoveryNoteRequest(input.budget);
    try {
      const pageIssues = await githubJson<GithubIssue[]>(`/repos/${input.repo}/issues?${query.toString()}`);
      discoveryNotePage(input.budget, pageIssues.length);
      issues.push(...pageIssues);
      if (pageIssues.length < 100) break;
      if (input.budget.rowsConsidered >= input.budget.maxRowsConsidered) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // No successful pages ⇒ hard failure for callers (e.g. org_scan per-repo outcomes).
      if (input.budget.pagesFetched === 0) throw error instanceof Error ? error : new Error(message);
      partial = true;
      partialReason = message;
      input.budget.truncated = true;
      if (!input.budget.truncateReasons.includes('provider error during pagination')) {
        input.budget.truncateReasons.push('provider error during pagination');
      }
      break;
    }
  }
  return { issues, partial, partialReason };
}

function filterIssues(
  issues: GithubIssue[],
  input: Input,
  sinceDate: Date | null,
  counts: FilterCounts
): GithubIssue[] {
  const out: GithubIssue[] = [];
  for (const issue of issues) {
    if ('pull_request' in issue) {
      counts.pr_row += 1;
      continue;
    }
    if (!matchesLabel(issue, input.label)) {
      counts.label_mismatch += 1;
      continue;
    }
    if (!matchesKeywords(issue, input.keywords)) {
      counts.keyword_mismatch += 1;
      continue;
    }
    if (sinceDate && Date.parse(issue.created_at) < sinceDate.getTime()) {
      counts.since_mismatch += 1;
      continue;
    }
    out.push(issue);
  }
  return out;
}

export async function scan(input: Input): Promise<Envelope> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const maxPages = Math.min(Math.max(input.max_pages ?? 1, 1), 5);
  const budget = createDiscoveryBudget({
    maxPages,
    maxRowsConsidered: maxPages * 100
  });
  const filterCounts = emptyFilterCounts();
  const fetched = await fetchIssuePages({ repo: input.repo, label: input.label, budget });
  const sinceDate = sinceToDate(input.since);
  const filteredIssues = filterIssues(fetched.issues, input, sinceDate, filterCounts);
  const filteredCandidates = filteredIssues.map(candidate);

  const profile = resolveSkillProfile(input.skill_profile);
  const skillFitChecked: string[] = [];
  if (profile) {
    discoveryNoteRequest(budget);
    const repoHints = await fetchRepoHints(input.repo);
    applySkillFit(filteredIssues, filteredCandidates, profile, repoHints);
    skillFitChecked.push(`skill_profile provided: computed fit_score for ${filteredCandidates.length} candidate${filteredCandidates.length === 1 ? '' : 's'}${repoHints ? ' using repo language/topics/description hints' : ' (repo hints unavailable; issue text/labels only)'}`);
  } else if (input.skill_profile !== undefined) {
    skillFitChecked.push('skill_profile provided but could not be parsed into any recognized languages/topics/avoid terms; fit_score not computed');
  } else {
    skillFitChecked.push('no skill_profile provided; fit_score not computed');
  }

  const landHintsEnabled = input.land_hints !== false;
  for (const item of filteredCandidates) {
    if (item.assignees.length > 0) filterCounts.assigned += 1;
    if (item.soft_ask) filterCounts.soft_ask += 1;
  }
  const landHints = landHintsEnabled ? await applyLandHints(input.repo, filteredCandidates) : { checked: [], not_checked: [] };
  for (const item of filteredCandidates) {
    if (item.likely_land_only && item.assignees.length === 0) filterCounts.land_only += 1;
  }

  const ranked = filteredCandidates
    .map((item) => {
      const components = rankCandidate(item, input.ranking_weights);
      item.availability_hint_score = components.availability_hint_score;
      item.rank_score = components.rank_score;
      item.ranking_version = components.ranking_version;
      if (input.explain_ranking) item.ranking_explain = explainRankingLines(item, components);
      return { item, components };
    })
    .sort((left, right) => compareRanked(
      { ...left.components, number: left.item.number, updated_at: left.item.updated_at },
      { ...right.components, number: right.item.number, updated_at: right.item.updated_at }
    ))
    .map((entry) => entry.item);

  const { selected: candidates, backfilled } = shortlistWithBackfill(ranked, limit);
  const policyHint = await cachedPolicyHint(input.repo);
  const discovery: DiscoveryMeta = toDiscoveryMeta({
    budget,
    filterCounts,
    shortlistBackfilled: backfilled,
    partial: fetched.partial,
    partialReason: fetched.partialReason
  });
  notePagesFetched(discovery.pages_fetched);
  noteCandidatesConsidered(discovery.rows_considered);
  const widenHint = widenHintEvidence(input, candidates, limit);
  const evidence = [
    ...candidates,
    { kind: 'discovery', ...discovery },
    ...(input.explain_ranking
      ? [{ kind: 'ranking_explain', ranking_version: RANKING_VERSION, lines: candidates.flatMap((item) => item.ranking_explain ?? []) }]
      : []),
    ...(widenHint ? [widenHint] : [])
  ];
  return createEnvelope({
    verdict_summary: fetched.partial
      ? `partial scan: found ${candidates.length} open issue ${candidates.length === 1 ? 'candidate' : 'candidates'} before discovery stopped (${discovery.partial_reason ?? 'budget/error'}); scan does not vet them.`
      : `found ${candidates.length} open issue ${candidates.length === 1 ? 'candidate' : 'candidates'} ranked by rank_score (v${RANKING_VERSION}); scan does not vet them.`,
    evidence,
    checked: [
      `fetched open issues for ${input.repo} across ${discovery.pages_fetched} page(s) (${discovery.rows_considered} rows considered)`,
      'excluded pull requests before shortlist truncation',
      `ranked candidates with ranking_version=${RANKING_VERSION} (quality, fit, availability)`,
      `shortlist limit ${limit}; backfilled ${backfilled} slot(s) after availability filters`,
      input.label ? `filtered by label: ${input.label}` : 'no label filter requested',
      input.keywords?.length ? `filtered titles and bodies by keywords: ${input.keywords.join(', ')}` : 'no keyword filter requested',
      input.since ? `filtered by created date since ${input.since}` : 'no age filter requested',
      landHintsEnabled ? 'land_hints enabled: flagged likely land-only candidates from assignees and open PR search' : 'land_hints disabled by request',
      ...skillFitChecked,
      ...policyHint.checked,
      ...landHints.checked,
      ...(discovery.truncated ? [`discovery truncated: ${discovery.truncate_reasons.join('; ')}`] : []),
      ...(widenHint ? [`widen hint: ${widenHint.reason}`] : [])
    ],
    not_checked: [TRACKER_LIMIT, ...policyHint.not_checked, ...landHints.not_checked],
    cached: false
  });
}
