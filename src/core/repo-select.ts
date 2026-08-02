/** Skill-aware repository selection for org_scan (GW-027). */

import type { SkillProfileV1, TargetManifest } from '../contracts/config.js';
import { resolveSkillProfile, type SkillProfile } from './skill-fit.js';

export const REPO_SELECTION_VERSION = '1' as const;

export type SelectableRepo = {
  full_name: string;
  archived?: boolean;
  fork?: boolean;
  stargazers_count?: number;
  pushed_at?: string | null;
  updated_at?: string;
  language?: string | null;
  topics?: string[];
  description?: string | null;
  open_issues_count?: number;
};

export type RepoSelectionReason = {
  repo: string;
  action: 'included' | 'excluded' | 'truncated';
  reasons: string[];
  selection_score?: number;
};

export type RepoSelectionMeta = {
  kind: 'repo_selection';
  selection_version: typeof REPO_SELECTION_VERSION;
  considered: number;
  selected: number;
  truncated: boolean;
  package_mappings: Array<{ repo: string; npm_package: string }>;
  rows: RepoSelectionReason[];
};

export type RepoSelectionInput = {
  repos: SelectableRepo[];
  maxRepos: number;
  skill_profile?: SkillProfile | SkillProfileV1 | string;
  manifest?: TargetManifest;
  org?: string;
  /** Minimum days since last push; 0 disables. Default 365. */
  max_inactive_days?: number;
};

function repoOf(entry: string | { repo: string }): string {
  return typeof entry === 'string' ? entry : entry.repo;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / (24 * 60 * 60 * 1000));
}

function packageMappingsFor(manifest: TargetManifest | undefined, selected: string[]): Array<{ repo: string; npm_package: string }> {
  if (!manifest) return [];
  const map = new Map<string, string>();
  for (const item of manifest.package_mappings ?? []) map.set(item.repo, item.npm_package);
  for (const entry of manifest.repos ?? []) {
    if (typeof entry === 'string' || !entry.npm_package) continue;
    map.set(entry.repo, entry.npm_package);
  }
  return selected
    .filter((repo) => map.has(repo))
    .map((repo) => ({ repo, npm_package: map.get(repo)! }));
}

function skillScore(repo: SelectableRepo, profile: SkillProfile | null): { score: number; reasons: string[] } {
  if (!profile) return { score: 0.5, reasons: ['no skill_profile; neutral fit'] };
  const hay = [
    repo.language ?? '',
    ...(repo.topics ?? []),
    repo.description ?? '',
    repo.full_name
  ].join(' ').toLowerCase();
  const matched: string[] = [];
  const avoided: string[] = [];
  for (const term of [...(profile.languages ?? []), ...(profile.topics ?? []), ...(profile.preferred_ecosystems ?? [])]) {
    if (hay.includes(normalize(term))) matched.push(term);
  }
  for (const term of [...(profile.avoid ?? []), ...(profile.avoid_languages ?? []), ...(profile.avoid_topics ?? []), ...(profile.avoid_ecosystems ?? [])]) {
    if (hay.includes(normalize(term))) avoided.push(term);
  }
  const score = 0.35 + Math.min(0.5, matched.length * 0.12) - Math.min(0.45, avoided.length * 0.2);
  const reasons: string[] = [];
  if (matched.length) reasons.push(`skill matched: ${matched.join(', ')}`);
  if (avoided.length) reasons.push(`skill avoided: ${avoided.join(', ')}`);
  if (!matched.length && !avoided.length) reasons.push('skill_profile present but no language/topic overlap');
  return { score: Math.max(0, Math.min(1, score)), reasons };
}

function activityScore(repo: SelectableRepo): { score: number; reasons: string[]; inactive: boolean; days: number | null } {
  const days = daysSince(repo.pushed_at ?? repo.updated_at);
  if (days === null) return { score: 0.4, reasons: ['activity unknown'], inactive: false, days: null };
  if (days <= 30) return { score: 1, reasons: [`pushed ${Math.round(days)}d ago`], inactive: false, days };
  if (days <= 90) return { score: 0.8, reasons: [`pushed ${Math.round(days)}d ago`], inactive: false, days };
  if (days <= 180) return { score: 0.55, reasons: [`pushed ${Math.round(days)}d ago`], inactive: false, days };
  if (days <= 365) return { score: 0.35, reasons: [`pushed ${Math.round(days)}d ago`], inactive: false, days };
  return { score: 0.1, reasons: [`stale: pushed ${Math.round(days)}d ago`], inactive: true, days };
}

/**
 * Select repositories for org scouting: include/exclude override heuristics;
 * skill fit + activity outrank pure stars.
 */
export function selectRepos(input: RepoSelectionInput): {
  selected: SelectableRepo[];
  meta: RepoSelectionMeta;
} {
  const profile = resolveSkillProfile(input.skill_profile);
  const maxInactive = input.max_inactive_days ?? 365;
  const includeRepos = new Set((input.manifest?.include?.repos ?? []).map(normalize));
  const excludeRepos = new Set((input.manifest?.exclude?.repos ?? []).map(normalize));
  const explicitRepos = (input.manifest?.repos ?? [])
    .map(repoOf)
    .filter((name) => !input.org || name.toLowerCase().startsWith(`${input.org.toLowerCase()}/`));
  const explicitSet = new Set(explicitRepos.map(normalize));

  const rows: RepoSelectionReason[] = [];
  const scored: Array<{ repo: SelectableRepo; score: number; forced: boolean }> = [];

  for (const repo of input.repos) {
    const key = normalize(repo.full_name);
    const reasons: string[] = [];

    if (repo.archived) {
      rows.push({ repo: repo.full_name, action: 'excluded', reasons: ['archived'] });
      continue;
    }
    if (repo.fork) {
      rows.push({ repo: repo.full_name, action: 'excluded', reasons: ['fork'] });
      continue;
    }
    if (excludeRepos.has(key)) {
      rows.push({ repo: repo.full_name, action: 'excluded', reasons: ['manifest exclude.repos'] });
      continue;
    }
    if (includeRepos.size > 0 && !includeRepos.has(key) && !explicitSet.has(key)) {
      rows.push({ repo: repo.full_name, action: 'excluded', reasons: ['not in manifest include.repos'] });
      continue;
    }

    const activity = activityScore(repo);
    if (activity.inactive && maxInactive > 0 && (activity.days ?? 0) > maxInactive && !explicitSet.has(key) && !includeRepos.has(key)) {
      rows.push({ repo: repo.full_name, action: 'excluded', reasons: [`inactive beyond ${maxInactive}d`, ...activity.reasons] });
      continue;
    }

    const skill = skillScore(repo, profile);
    const stars = Math.log10((repo.stargazers_count ?? 0) + 1) / 5; // weak signal
    const openIssues = Math.min(1, (repo.open_issues_count ?? 0) / 50) * 0.1;
    const forced = explicitSet.has(key) || includeRepos.has(key);
    const score = Number((
      skill.score * 0.45
      + activity.score * 0.35
      + stars * 0.15
      + openIssues
      + (forced ? 0.25 : 0)
    ).toFixed(6));

    reasons.push(...skill.reasons, ...activity.reasons, `stars=${repo.stargazers_count ?? 0}`);
    if (forced) reasons.push(explicitSet.has(key) ? 'manifest repos entry' : 'manifest include.repos');
    scored.push({ repo, score, forced });
    rows.push({ repo: repo.full_name, action: 'included', reasons, selection_score: score });
  }

  scored.sort((left, right) =>
    Number(right.forced) - Number(left.forced)
    || right.score - left.score
    || (right.repo.stargazers_count ?? 0) - (left.repo.stargazers_count ?? 0)
    || left.repo.full_name.localeCompare(right.repo.full_name)
  );

  const selected = scored.slice(0, input.maxRepos).map((item) => item.repo);
  const selectedSet = new Set(selected.map((item) => item.full_name));
  const truncated = scored.length > selected.length;
  for (const item of scored.slice(input.maxRepos)) {
    const row = rows.find((entry) => entry.repo === item.repo.full_name && entry.action === 'included');
    if (row) {
      row.action = 'truncated';
      row.reasons = [...row.reasons, `truncated by max_repos=${input.maxRepos}`];
    }
  }

  return {
    selected,
    meta: {
      kind: 'repo_selection',
      selection_version: REPO_SELECTION_VERSION,
      considered: input.repos.length,
      selected: selected.length,
      truncated,
      package_mappings: packageMappingsFor(input.manifest, [...selectedSet]),
      rows
    }
  };
}

export function resolvePackageForRepo(
  repo: string,
  manifest: TargetManifest | undefined,
  globalNpm?: string
): { npm_package?: string; ambiguous: boolean; warning?: string } {
  if (!manifest) return { npm_package: globalNpm, ambiguous: false };
  const mapped = packageMappingsFor(manifest, [repo])[0]?.npm_package;
  if (mapped && globalNpm && mapped !== globalNpm) {
    return {
      npm_package: mapped,
      ambiguous: true,
      warning: `global npm_package=${globalNpm} conflicts with manifest mapping ${mapped} for ${repo}; using per-repo mapping`
    };
  }
  if (mapped) return { npm_package: mapped, ambiguous: false };
  if (globalNpm && (manifest.repos?.length ?? 0) + (manifest.orgs?.length ?? 0) > 1) {
    return {
      npm_package: undefined,
      ambiguous: true,
      warning: `ambiguous global npm_package=${globalNpm} across multi-target manifest; release probes disabled unless per-repo mapping exists`
    };
  }
  return { npm_package: globalNpm, ambiguous: false };
}
