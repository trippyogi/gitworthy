import { githubJson } from '../lib/github.js';
import type { TargetManifest } from '../contracts/config.js';
import { createEnvelope, Envelope, GitworthyError } from './envelope.js';
import { selectRepos, type SelectableRepo } from './repo-select.js';
import { scan } from './scan.js';
import { SkillProfile } from './skill-fit.js';

type Input = {
  org: string;
  label?: string;
  keywords?: string[];
  since?: string;
  limit?: number;
  max_repos?: number;
  land_hints?: boolean;
  skill_profile?: SkillProfile | string;
  max_pages?: number;
  explain_ranking?: boolean;
  target_manifest?: TargetManifest;
};

type GithubRepoSummary = SelectableRepo;

type RepoScanOutcome = {
  repo: string;
  candidates: Array<Record<string, unknown> & { repo: string }>;
  checked: string[];
  not_checked: string[];
  failed: boolean;
  error?: string;
};

const MAX_REPO_LIST_PAGES = 2;
const DEFAULT_MAX_REPOS = 8;
const MAX_MAX_REPOS = 20;
const DEFAULT_LIMIT = 25;
const MIN_PER_REPO_LIMIT = 5;
const CONCURRENCY = 2;
const ORG_SCAN_LIMIT = 'org_scan ranks candidates across multiple repositories by rank_score (quality/fit/availability); it does not replace per-repo contrib_policy, duplicate, or in-flight checks before opening a PR.';
const META_EVIDENCE_KINDS = new Set(['widen_hint', 'discovery', 'ranking_explain']);

async function listOrgRepos(org: string): Promise<{ repos: GithubRepoSummary[]; checked: string[]; not_checked: string[] }> {
  const not_checked: string[] = [];
  const attempts: Array<{ base: string; label: string }> = [
    { base: `/orgs/${org}/repos`, label: 'org' },
    { base: `/users/${org}/repos`, label: 'user' }
  ];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const repos: GithubRepoSummary[] = [];
      for (let page = 1; page <= MAX_REPO_LIST_PAGES; page += 1) {
        const query = new URLSearchParams({ type: 'public', sort: 'updated', per_page: '100', page: String(page) });
        const pageRepos = await githubJson<GithubRepoSummary[]>(`${attempt.base}?${query.toString()}`);
        repos.push(...pageRepos);
        if (pageRepos.length < 100) break;
      }
      return {
        repos,
        checked: [`listed public repositories for ${org} via ${attempt.label} endpoint (${repos.length} found, up to ${MAX_REPO_LIST_PAGES} page(s))`],
        not_checked
      };
    } catch (error) {
      lastError = error;
      if (error instanceof GitworthyError && error.status === 404 && attempt.label === 'org') {
        not_checked.push(`org repos endpoint returned 404 for ${org}; retried as a user account.`);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new GitworthyError({
      code: 'org_scan_list_failed',
      message: `Could not list public repositories for ${org}.`,
      not_checked: [`repository listing failed for ${org}.`]
    });
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function scanRepo(repoFullName: string, input: Input, perRepoLimit: number): Promise<RepoScanOutcome> {
  try {
    const result = await scan({
      repo: repoFullName,
      label: input.label,
      keywords: input.keywords,
      since: input.since,
      limit: perRepoLimit,
      land_hints: input.land_hints,
      skill_profile: input.skill_profile,
      max_pages: input.max_pages,
      explain_ranking: input.explain_ranking
    });
    const candidates = result.evidence
      .filter((item) => !('kind' in item && typeof item.kind === 'string' && META_EVIDENCE_KINDS.has(item.kind)))
      .map((item) => ({ ...item, repo: repoFullName }));
    return { repo: repoFullName, candidates, checked: result.checked, not_checked: result.not_checked, failed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { repo: repoFullName, candidates: [], checked: [], not_checked: [], failed: true, error: message };
  }
}

export async function org_scan(input: Input): Promise<Envelope> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100);
  const maxRepos = Math.min(Math.max(input.max_repos ?? DEFAULT_MAX_REPOS, 1), MAX_MAX_REPOS);
  const perRepoLimit = Math.max(MIN_PER_REPO_LIMIT, input.limit ?? DEFAULT_LIMIT);
  const { repos, checked: listChecked, not_checked: listNotChecked } = await listOrgRepos(input.org);
  const { selected, meta: selection } = selectRepos({
    repos,
    maxRepos,
    skill_profile: input.skill_profile,
    manifest: input.target_manifest,
    org: input.org
  });
  const outcomes = await mapWithConcurrency(selected, CONCURRENCY, (repo) => scanRepo(repo.full_name, input, perRepoLimit));

  const candidates = outcomes
    .flatMap((outcome) => outcome.candidates)
    .sort((left, right) =>
      Number(right.rank_score ?? 0) - Number(left.rank_score ?? 0) ||
      Number(right.quality_score ?? 0) - Number(left.quality_score ?? 0) ||
      Number(right.fit_score ?? 0) - Number(left.fit_score ?? 0) ||
      Date.parse(String(right.updated_at ?? '')) - Date.parse(String(left.updated_at ?? ''))
    )
    .slice(0, limit);

  const scannedNames = outcomes.filter((outcome) => !outcome.failed).map((outcome) => outcome.repo);
  const failedOutcomes = outcomes.filter((outcome) => outcome.failed);

  const aggregatedChecked = new Set<string>();
  const aggregatedNotChecked = new Set<string>();
  for (const outcome of outcomes) {
    outcome.checked.forEach((item) => aggregatedChecked.add(item));
    outcome.not_checked.forEach((item) => aggregatedNotChecked.add(item));
  }

  const excludedCount = selection.rows.filter((row) => row.action === 'excluded').length;
  const checked = [
    ...listChecked,
    `repo selection v${selection.selection_version}: considered ${selection.considered}, excluded ${excludedCount}, selected ${selection.selected}${selection.truncated ? ' (truncated)' : ''}`,
    'excluded archived and forked repositories',
    `ranked eligible repositories by skill fit, recent activity, then stars (not stars alone)`,
    `selected top ${selected.length} repositor${selected.length === 1 ? 'y' : 'ies'} (max_repos=${maxRepos})`,
    scannedNames.length > 0 ? `scanned: ${scannedNames.join(', ')}` : 'no repositories were scanned',
    ...(selection.package_mappings.length
      ? [`applied ${selection.package_mappings.length} per-repo npm package mapping(s)`]
      : []),
    ...aggregatedChecked
  ];

  const not_checked = [
    ...listNotChecked,
    ORG_SCAN_LIMIT,
    ...(failedOutcomes.length > 0
      ? [`scan failed for ${failedOutcomes.length} repositor${failedOutcomes.length === 1 ? 'y' : 'ies'}: ${failedOutcomes.map((outcome) => `${outcome.repo} (${outcome.error})`).join('; ')}`]
      : []),
    ...aggregatedNotChecked
  ];

  return createEnvelope({
    verdict_summary: `found ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} across ${scannedNames.length} repo${scannedNames.length === 1 ? '' : 's'} in ${input.org}; org-level scan does not vet them.`,
    evidence: [selection, ...candidates],
    checked,
    not_checked,
    cached: false
  });
}
