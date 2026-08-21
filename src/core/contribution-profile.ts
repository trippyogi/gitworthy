import {
  ContributionProfileSchema,
  type ContributionProfile,
  type PlatformHint
} from '../contracts/contribution-profile.js';

export const GENERIC_CONTRIBUTION_PROFILE: ContributionProfile = ContributionProfileSchema.parse({
  mode_weights: {
    BUILD: 1,
    REVIEW: 1,
    SALVAGE: 1,
    REPRODUCE: 1,
    EVAL: 1,
    DOC: 0.7,
    WATCH: 0.5,
    PASS: 0
  },
  domains: [],
  platforms: [],
  wip_limits: {
    BUILD: 2,
    SALVAGE: 1,
    deep_investigation: 1
  },
  stale_pr_days: 14
});

const PLATFORM_PATTERNS: Array<{ platform: PlatformHint; pattern: RegExp }> = [
  { platform: 'windows', pattern: /\b(windows|win32|win64|powershell)\b/i },
  { platform: 'macos', pattern: /\b(macos|osx|darwin)\b/i },
  { platform: 'wsl', pattern: /\b(wsl2?|windows subsystem)\b/i },
  { platform: 'linux', pattern: /\b(linux|ubuntu|debian|fedora|rhel)\b/i },
  { platform: 'container', pattern: /\b(docker|container|podman|kubernetes|k8s)\b/i }
];

export function parseContributionProfile(input?: unknown): ContributionProfile {
  if (input === undefined) return GENERIC_CONTRIBUTION_PROFILE;
  const parsed = ContributionProfileSchema.parse(input);
  return {
    ...GENERIC_CONTRIBUTION_PROFILE,
    ...parsed,
    mode_weights: { ...GENERIC_CONTRIBUTION_PROFILE.mode_weights, ...parsed.mode_weights },
    wip_limits: { ...GENERIC_CONTRIBUTION_PROFILE.wip_limits, ...parsed.wip_limits },
    domains: parsed.domains,
    platforms: parsed.platforms
  };
}

export function extractPlatformHints(input: {
  title?: string;
  body?: string | null;
  labels?: string[];
}): PlatformHint[] {
  const labels = (input.labels ?? []).map((label) => label.toLowerCase());
  const text = `${input.title ?? ''}\n${input.body ?? ''}\n${labels.join(' ')}`;
  const found = new Set<PlatformHint>();
  for (const label of labels) {
    for (const platform of ['windows', 'linux', 'macos', 'wsl', 'container'] as const) {
      if (label === platform || label.includes(platform)) found.add(platform);
    }
  }
  for (const { platform, pattern } of PLATFORM_PATTERNS) {
    if (pattern.test(text)) found.add(platform);
  }
  return [...found];
}

export function matchDomains(input: {
  title?: string;
  body?: string | null;
  labels?: string[];
  topics?: string[];
  paths?: string[];
}, profile: ContributionProfile = GENERIC_CONTRIBUTION_PROFILE): {
  matched_domains: string[];
  domain_fit_score: number;
  reasons: string[];
} {
  const haystack = [
    input.title ?? '',
    input.body ?? '',
    ...(input.labels ?? []),
    ...(input.topics ?? []),
    ...(input.paths ?? [])
  ].join(' ').toLowerCase();
  const matched: Array<{ id: string; weight: number; term: string }> = [];
  const reasons: string[] = [];
  for (const domain of profile.domains) {
    const hit = domain.terms.find((term) => haystack.includes(term.toLowerCase()));
    if (!hit) continue;
    matched.push({ id: domain.id, weight: domain.weight, term: hit });
    reasons.push(`domain ${domain.id} matched "${hit}"`);
  }
  if (matched.length === 0) return { matched_domains: [], domain_fit_score: 0.5, reasons: ['no configured domain terms matched'] };
  const weightSum = matched.reduce((sum, item) => sum + item.weight, 0);
  const domain_fit_score = Math.max(0, Math.min(1, weightSum / (weightSum + 1)));
  return { matched_domains: matched.map((item) => item.id), domain_fit_score, reasons };
}

export function platformExecutionFit(required: PlatformHint[], available: PlatformHint[]): {
  execution_fit: number;
  matched: PlatformHint[];
  unavailable: PlatformHint[];
  reasons: string[];
} {
  if (required.length === 0) {
    return { execution_fit: 1, matched: [], unavailable: [], reasons: ['no platform requirement'] };
  }
  const have = new Set(available);
  const matched = required.filter((platform) => have.has(platform));
  const unavailable = required.filter((platform) => !have.has(platform));
  if (unavailable.length === 0) {
    return {
      execution_fit: 1,
      matched,
      unavailable,
      reasons: [`required platform available: ${matched.join(', ')}`]
    };
  }
  if (available.length === 0) {
    return {
      execution_fit: 0.4,
      matched,
      unavailable,
      reasons: [`required platform unavailable: ${unavailable.join(', ')}; execution_fit lowered, confidence unchanged`]
    };
  }
  return {
    execution_fit: matched.length / required.length,
    matched,
    unavailable,
    reasons: [`required platform unavailable: ${unavailable.join(', ')}; execution_fit lowered, confidence unchanged`]
  };
}
