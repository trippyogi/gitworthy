/** Transparent candidate ranking contract (GW-026). */

export const RANKING_VERSION = '1' as const;

export type RankingWeights = {
  quality: number;
  fit: number;
  availability: number;
};

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  quality: 0.55,
  fit: 0.25,
  availability: 0.2
};

export type RankComponents = {
  quality_score: number;
  quality_norm: number;
  fit_score: number | null;
  availability_hint_score: number;
  availability_reasons: string[];
  rank_score: number;
  ranking_version: typeof RANKING_VERSION;
  weights: RankingWeights;
  not_applicable: string[];
};

export type RankableCandidate = {
  number: number;
  quality_score: number;
  quality_reasons: string[];
  fit_score?: number;
  fit_reasons?: string[];
  assignees: string[];
  likely_land_only?: boolean;
  soft_ask: boolean;
  updated_at: string;
};

export function normalizeWeights(input?: Partial<RankingWeights>): RankingWeights {
  const weights = {
    quality: clamp(input?.quality ?? DEFAULT_RANKING_WEIGHTS.quality, 0, 1),
    fit: clamp(input?.fit ?? DEFAULT_RANKING_WEIGHTS.fit, 0, 1),
    availability: clamp(input?.availability ?? DEFAULT_RANKING_WEIGHTS.availability, 0, 1)
  };
  const sum = weights.quality + weights.fit + weights.availability;
  if (sum <= 0) return { ...DEFAULT_RANKING_WEIGHTS };
  return {
    quality: weights.quality / sum,
    fit: weights.fit / sum,
    availability: weights.availability / sum
  };
}

export function availabilityHintScore(candidate: Pick<RankableCandidate, 'assignees' | 'likely_land_only' | 'soft_ask'>): {
  score: number;
  reasons: string[];
} {
  let score = 1;
  const reasons: string[] = [];
  if (candidate.assignees.length > 0) {
    score -= 0.45;
    reasons.push('assigned');
  }
  if (candidate.likely_land_only) {
    score -= 0.35;
    reasons.push('likely_land_only');
  }
  if (candidate.soft_ask) {
    score -= 0.15;
    reasons.push('soft_ask');
  }
  return { score: clamp(score, 0, 1), reasons };
}

export function rankCandidate(
  candidate: RankableCandidate,
  weightsInput?: Partial<RankingWeights>
): RankComponents {
  const weights = normalizeWeights(weightsInput);
  const quality_norm = clamp(candidate.quality_score / 100, 0, 1);
  const fit = typeof candidate.fit_score === 'number' ? clamp(candidate.fit_score, 0, 1) : null;
  const availability = availabilityHintScore(candidate);
  const not_applicable: string[] = [];
  if (fit === null) not_applicable.push('fit_score');

  const fitTerm = fit ?? 0;
  const fitWeight = fit === null ? 0 : weights.fit;
  const qualityWeight = fit === null ? weights.quality + weights.fit : weights.quality;
  const rank_score = Number((
    quality_norm * qualityWeight
    + fitTerm * fitWeight
    + availability.score * weights.availability
  ).toFixed(6));

  return {
    quality_score: candidate.quality_score,
    quality_norm,
    fit_score: fit,
    availability_hint_score: availability.score,
    availability_reasons: availability.reasons,
    rank_score,
    ranking_version: RANKING_VERSION,
    weights: fit === null
      ? { quality: qualityWeight, fit: 0, availability: weights.availability }
      : weights,
    not_applicable
  };
}

export function compareRanked(left: RankComponents & { number: number; updated_at: string }, right: RankComponents & { number: number; updated_at: string }): number {
  return right.rank_score - left.rank_score
    || Date.parse(right.updated_at) - Date.parse(left.updated_at)
    || left.number - right.number;
}

export function explainRankingLines(candidate: RankableCandidate, components: RankComponents): string[] {
  return [
    `#${candidate.number} rank_score=${components.rank_score} (ranking_version=${components.ranking_version})`,
    `  quality=${components.quality_score}→${components.quality_norm.toFixed(3)} × ${components.weights.quality.toFixed(2)}`,
    `  fit=${components.fit_score === null ? 'n/a' : components.fit_score.toFixed(3)} × ${components.weights.fit.toFixed(2)}`,
    `  availability=${components.availability_hint_score.toFixed(3)} × ${components.weights.availability.toFixed(2)}${components.availability_reasons.length ? ` (${components.availability_reasons.join(', ')})` : ''}`,
    ...(components.not_applicable.length ? [`  not_applicable: ${components.not_applicable.join(', ')}`] : [])
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
