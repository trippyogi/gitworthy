import type { ContributionMode, EffortBucket } from '../contracts/routing.js';
import type { ContributionProfile, PlatformHint } from '../contracts/contribution-profile.js';
import { GENERIC_CONTRIBUTION_PROFILE, platformExecutionFit } from './contribution-profile.js';

const EFFORT_NORM: Record<Exclude<EffortBucket, 'unknown'>, number> = {
  fast: 0.15,
  medium: 0.4,
  deep: 0.7,
  research: 0.9
};

export type OpportunityScoreInput = {
  mode: ContributionMode;
  impact: number;
  fit: number;
  evidenceability: number;
  availability: number;
  domain_value: number;
  effort_bucket: EffortBucket;
  hard_constraints?: string[];
  suppress_build?: boolean;
  required_platforms?: PlatformHint[];
  profile?: ContributionProfile;
};

export type OpportunityScore = {
  mode: ContributionMode;
  score: number;
  benefit: number;
  effort_factor: number;
  effort_bucket: EffortBucket;
  execution_fit: number;
  reasons: string[];
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function effortFactor(bucket: EffortBucket): number {
  if (bucket === 'unknown') return 1;
  return 0.6 + (0.8 * EFFORT_NORM[bucket]);
}

/** Mode-specific opportunity score. Hard constraints force BUILD=0; they are not a penalty. */
export function scoreOpportunity(input: OpportunityScoreInput): OpportunityScore {
  const profile = input.profile ?? GENERIC_CONTRIBUTION_PROFILE;
  const reasons: string[] = [];
  const benefit = clamp01(
    0.30 * clamp01(input.impact)
    + 0.20 * clamp01(input.fit)
    + 0.20 * clamp01(input.evidenceability)
    + 0.15 * clamp01(input.availability)
    + 0.15 * clamp01(input.domain_value)
  );
  const effort_factor = effortFactor(input.effort_bucket);
  if (input.effort_bucket === 'unknown') reasons.push('unknown effort stays unknown; no effort discount applied');
  const platform = platformExecutionFit(input.required_platforms ?? [], profile.platforms);
  reasons.push(...platform.reasons);
  const weight = profile.mode_weights[input.mode] ?? 1;
  let score = clamp01((benefit / effort_factor) * weight);
  if (input.mode === 'REPRODUCE' && platform.matched.length > 0) {
    score = clamp01(score + 0.08);
    reasons.push('matching platform raises REPRODUCE');
  }
  if (['BUILD', 'REPRODUCE', 'SALVAGE'].includes(input.mode) && platform.execution_fit < 1) {
    score = clamp01(score * (0.7 + 0.3 * platform.execution_fit));
  }
  const suppress = input.suppress_build === true
    || (input.hard_constraints ?? []).includes('suppress_build');
  if (input.mode === 'BUILD' && suppress) {
    score = 0;
    reasons.push('hard constraint forces BUILD=0');
  }
  return {
    mode: input.mode,
    score,
    benefit,
    effort_factor,
    effort_bucket: input.effort_bucket,
    execution_fit: platform.execution_fit,
    reasons
  };
}

export function scoreModes(input: Omit<OpportunityScoreInput, 'mode'> & {
  modes?: ContributionMode[];
}): Record<ContributionMode, OpportunityScore> {
  const modes = input.modes ?? ['BUILD', 'REVIEW', 'SALVAGE', 'REPRODUCE', 'EVAL', 'DOC', 'WATCH', 'PASS'];
  const out = {} as Record<ContributionMode, OpportunityScore>;
  for (const mode of modes) out[mode] = scoreOpportunity({ ...input, mode });
  return out;
}
