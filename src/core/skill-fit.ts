export type SkillProfile = {
  languages?: string[];
  topics?: string[];
  avoid?: string[];
};

export type SkillFitInput = {
  profile: SkillProfile;
  issue: { title: string; body?: string | null; labels?: string[] };
  repoHints?: { language?: string | null; topics?: string[]; description?: string | null };
};

export type SkillFitResult = {
  score: number;
  reasons: string[];
  matched: string[];
  avoided: string[];
};

const LANGUAGE_HIT_WEIGHT = 0.15;
const LANGUAGE_HIT_CAP = 0.3;
const TOPIC_HIT_WEIGHT = 0.1;
const TOPIC_HIT_CAP = 0.3;
const AVOID_HIT_WEIGHT = 0.25;
const BASE_SCORE = 0.5;

function normalizeTerms(terms: string[] | undefined): string[] {
  if (!terms) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const term = raw.trim().toLowerCase();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary match for alphanumeric terms; plain substring match otherwise (e.g. "c++"). */
function containsTerm(haystack: string, term: string): boolean {
  if (!term) return false;
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(term)) {
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:$|[^a-z0-9])`, 'i').test(`${haystack} `);
  }
  return haystack.includes(term);
}

function hitsAny(term: string, haystacks: string[]): boolean {
  return haystacks.some((haystack) => containsTerm(haystack, term));
}

/** Deterministic 0-1 fit score for how well an issue/repo matches a hunter's declared skill profile. */
export function scoreSkillFit(input: SkillFitInput): SkillFitResult {
  const { profile, issue, repoHints } = input;
  const text = `${issue.title}\n${issue.body ?? ''}`.toLowerCase();
  const labelHaystacks = (issue.labels ?? []).map((label) => label.toLowerCase());
  const repoLanguage = (repoHints?.language ?? '').toLowerCase();
  const repoTopicHaystacks = (repoHints?.topics ?? []).map((topic) => topic.toLowerCase());
  const repoDescription = (repoHints?.description ?? '').toLowerCase();

  const languages = normalizeTerms(profile.languages);
  const topics = normalizeTerms(profile.topics);
  const avoid = normalizeTerms(profile.avoid);

  const reasons: string[] = [];
  const matched: string[] = [];
  const avoided: string[] = [];
  let score = BASE_SCORE;

  const languageHaystacks = [text, ...labelHaystacks, repoLanguage];
  const languageHits = languages.filter((language) => hitsAny(language, languageHaystacks));
  if (languageHits.length > 0) {
    matched.push(...languageHits);
    const bonus = Math.min(LANGUAGE_HIT_CAP, languageHits.length * LANGUAGE_HIT_WEIGHT);
    score += bonus;
    reasons.push(`matched language(s) ${languageHits.join(', ')} (+${bonus.toFixed(2)})`);
  }

  const topicHaystacks = [text, ...labelHaystacks, ...repoTopicHaystacks, repoDescription];
  const topicHits = topics.filter((topic) => hitsAny(topic, topicHaystacks));
  if (topicHits.length > 0) {
    matched.push(...topicHits);
    const bonus = Math.min(TOPIC_HIT_CAP, topicHits.length * TOPIC_HIT_WEIGHT);
    score += bonus;
    reasons.push(`matched topic(s) ${topicHits.join(', ')} (+${bonus.toFixed(2)})`);
  }

  const avoidHaystacks = [text, ...labelHaystacks, repoLanguage, ...repoTopicHaystacks, repoDescription];
  const avoidHits = avoid.filter((term) => hitsAny(term, avoidHaystacks));
  if (avoidHits.length > 0) {
    avoided.push(...avoidHits);
    const penalty = avoidHits.length * AVOID_HIT_WEIGHT;
    score = Math.max(0, score - penalty);
    reasons.push(`matched avoid term(s) ${avoidHits.join(', ')} (-${penalty.toFixed(2)})`);
  }

  score = Math.max(0, Math.min(1, score));
  if (reasons.length === 0) reasons.push('no skill profile language, topic, or avoid terms matched; neutral fit');

  return { score, reasons, matched, avoided };
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === 'string');
  return items.length > 0 ? items : undefined;
}

function normalizeParsedProfile(parsed: Record<string, unknown>): SkillProfile | null {
  const profile: SkillProfile = {};
  const languages = toStringArray(parsed.languages ?? parsed.language);
  const topics = toStringArray(parsed.topics ?? parsed.topic);
  const avoid = toStringArray(parsed.avoid);
  if (languages) profile.languages = languages;
  if (topics) profile.topics = topics;
  if (avoid) profile.avoid = avoid;
  if (!profile.languages && !profile.topics && !profile.avoid) return null;
  return profile;
}

/**
 * Parses a skill profile from either a JSON object string or a compact
 * `key=value;key=value` string with comma-separated lists, e.g.
 * `languages=ts,go;topics=mcp,cli;avoid=swift`.
 */
export function parseSkillProfile(raw: string | undefined): SkillProfile | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return normalizeParsedProfile(parsed as Record<string, unknown>);
      }
    } catch {
      return null;
    }
    return null;
  }

  const profile: SkillProfile = {};
  const segments = trimmed.split(';').map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex === -1) continue;
    const key = segment.slice(0, eqIndex).trim().toLowerCase();
    const list = segment.slice(eqIndex + 1).split(',').map((value) => value.trim()).filter(Boolean);
    if (list.length === 0) continue;
    if (key === 'languages' || key === 'language') profile.languages = list;
    else if (key === 'topics' || key === 'topic') profile.topics = list;
    else if (key === 'avoid') profile.avoid = list;
  }
  if (!profile.languages && !profile.topics && !profile.avoid) return null;
  return profile;
}

/** Accepts either a pre-parsed profile object or a raw string (JSON or key=value form). */
export function resolveSkillProfile(input: SkillProfile | string | undefined): SkillProfile | null {
  if (!input) return null;
  if (typeof input === 'string') return parseSkillProfile(input);
  if (!input.languages?.length && !input.topics?.length && !input.avoid?.length) return null;
  return input;
}
