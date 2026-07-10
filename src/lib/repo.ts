import { GitworthyError } from '../core/envelope.js';
import { deleteCache, readCache, writeCache } from './cache.js';
import { githubJson } from './github.js';

export type ResolvedRepo = {
  input: string;
  full_name: string;
  default_branch: string;
  html_url: string;
};

export type CanonicalRepoContext = {
  full_name: string;
  default_branch: string;
  html_url: string;
  checked: string[];
  not_checked: string[];
  from_cache: boolean;
};

const SCOPE = 'resolve_repo';
const TTL = 24 * 60 * 60 * 1000;

type CachedRepo = { full_name: string; default_branch: string; html_url: string };

export async function resolveRepo(repo: string, force_refresh = false): Promise<ResolvedRepo & { cached: boolean }> {
  const cached = await readCache<CachedRepo>(SCOPE, { repo }, TTL, force_refresh);
  if (cached.hit) {
    return { input: repo, ...cached.value, cached: true };
  }
  const data = await githubJson<{ full_name: string; default_branch: string; html_url: string }>(`/repos/${repo}`);
  if (!data.full_name || !data.default_branch || !data.html_url) {
    throw new Error('incomplete repository metadata');
  }
  const value = { full_name: data.full_name, default_branch: data.default_branch, html_url: data.html_url };
  await writeCache(SCOPE, { repo }, value);
  return { input: repo, ...value, cached: false };
}

export async function bustRepoCache(repo: string): Promise<void> {
  await deleteCache(SCOPE, { repo });
}

export async function loadCanonicalRepo(repo: string, force_refresh = false): Promise<CanonicalRepoContext> {
  try {
    const resolved = await resolveRepo(repo, force_refresh);
    const checked: string[] = [];
    if (resolved.full_name.toLowerCase() !== repo.toLowerCase()) {
      checked.push(`resolved repository ${repo} to ${resolved.full_name}`);
    }
    return {
      full_name: resolved.full_name,
      default_branch: resolved.default_branch,
      html_url: resolved.html_url,
      checked,
      not_checked: [],
      from_cache: resolved.cached
    };
  } catch {
    return {
      full_name: repo,
      default_branch: 'main',
      html_url: `https://github.com/${repo}`,
      checked: [],
      not_checked: ['repository canonical name was not checked because the GitHub repo metadata request failed.'],
      from_cache: false
    };
  }
}

export async function runSearchWithCanonicalRepo<T>(
  repo: string,
  search: (fullName: string) => Promise<T>
): Promise<{ result: T; context: CanonicalRepoContext }> {
  let context = await loadCanonicalRepo(repo);
  try {
    return { result: await search(context.full_name), context };
  } catch (error) {
    if (!(error instanceof GitworthyError) || error.status !== 422 || !context.from_cache) throw error;
    await bustRepoCache(repo);
    context = await loadCanonicalRepo(repo, true);
    if (context.not_checked.length === 0) {
      context.checked.push('re-resolved repository after a Search API 422 on a cached canonical name');
    }
    return { result: await search(context.full_name), context };
  }
}
