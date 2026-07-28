import { distinctiveTerms } from './terms.js';

export type ReproHint = 'present' | 'weak' | 'missing';

export type QualityAssessment = {
  score: number;
  reasons: string[];
  repro: ReproHint;
  soft_ask: boolean;
  looks_like_bug: boolean;
};

type IssueLike = {
  title: string;
  body?: string | null;
  labels: string[];
  assignees: string[];
  comments: number;
  created_at: string;
  updated_at: string;
};

const REPRO_STRONG = /\b(steps?\s+to\s+reproduce|reproduction\s+steps|how\s+to\s+reproduce|to\s+reproduce|repro\s+steps|minimal\s+repro|minimal\s+reproduction|expected\s+behavior|actual\s+behavior|expected\s+result|actual\s+result)\b/i;
const REPRO_WEAK = /\b(reproduce|repro|stack\s*trace|traceback|error\s*message|version|npm\s+ls|npx|curl\s+|```|environment|os:|browser:)\b/i;
const SOFT_ASK = /\b(would\s+be\s+nice|nice\s+to\s+have|consider\s+(adding|supporting)|it\s+would\s+be\s+great|feature\s+request|wishlist|maybe\s+add|could\s+we\s+add|thoughts\s+on)\b/i;
const BUG_HINT = /\b(bug|error|fail(?:s|ed|ing)?|crash(?:es|ed|ing)?|broken|incorrect|regression|does\s+not|doesn't|dont\s+work|not\s+working|throws?|exception|undefined|null\s+reference)\b/i;
const NOISE_TITLE = /^\s*(\[bot(?:\s+issue)?\]|chore\(deps\)|bump\s+)/i;
const GOOD_LABELS = new Set(['good first issue', 'good-first-issue', 'help wanted', 'help-wanted', 'beginner', 'easy', 'up for grabs', 'hacktoberfest']);

function ageDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000)));
}

export function looksLikeBug(issue: Pick<IssueLike, 'title' | 'body' | 'labels'>): boolean {
  const labels = issue.labels.map((label) => label.toLowerCase());
  if (labels.some((label) => label === 'bug' || /(^|[^a-z])bug([^a-z]|$)/.test(label) || label === 'regression')) return true;
  return BUG_HINT.test(`${issue.title}\n${issue.body ?? ''}`);
}

export function assessRepro(body: string | null | undefined): ReproHint {
  const text = body ?? '';
  if (!text.trim()) return 'missing';
  if (REPRO_STRONG.test(text)) return 'present';
  if (REPRO_WEAK.test(text)) return 'weak';
  return 'missing';
}

export function isSoftAsk(issue: Pick<IssueLike, 'title' | 'body'>): boolean {
  return SOFT_ASK.test(`${issue.title}\n${issue.body ?? ''}`);
}

/** Score open-issue tracker candidates so scan can rank claimable work above soft asks and noise. */
export function assessIssueQuality(issue: IssueLike): QualityAssessment {
  const reasons: string[] = [];
  let score = 50;
  const labels = issue.labels.map((label) => label.toLowerCase());
  const createdDays = ageDays(issue.created_at);
  const updatedDays = ageDays(issue.updated_at);
  const bug = looksLikeBug(issue);
  const soft_ask = isSoftAsk(issue);
  const repro = assessRepro(issue.body);

  if (labels.some((label) => GOOD_LABELS.has(label))) {
    score += 12;
    reasons.push('contributor-friendly label');
  }

  if (bug) {
    score += 8;
    reasons.push('bug-shaped report');
  }
  if (repro === 'present') {
    score += 15;
    reasons.push('clear repro steps');
  } else if (repro === 'weak') {
    score += 5;
    reasons.push('partial repro signal');
  } else if (bug) {
    score -= 18;
    reasons.push('bug report lacks repro');
  }

  if (soft_ask) {
    score -= 20;
    reasons.push('soft feature ask');
  }
  if (NOISE_TITLE.test(issue.title) || labels.some((label) => label.includes('dependencies') || label === 'bot')) {
    score -= 30;
    reasons.push('automation or dependency noise');
  }
  if (issue.assignees.length > 0) {
    score -= 25;
    reasons.push('already assigned');
  }

  if (updatedDays <= 14) {
    score += 10;
    reasons.push('recent activity');
  } else if (updatedDays <= 60) {
    score += 4;
  } else if (updatedDays >= 180) {
    score -= 12;
    reasons.push('stale tracker activity');
  }

  if (createdDays >= 400 && updatedDays >= 90) {
    score -= 8;
    reasons.push('long-lived with little recent engagement');
  }

  if (issue.comments >= 1 && issue.comments <= 12) {
    score += 4;
    reasons.push('some discussion');
  } else if (issue.comments > 40) {
    score -= 6;
    reasons.push('very noisy thread');
  }

  const bodyLen = (issue.body ?? '').trim().length;
  if (bodyLen >= 200) score += 3;
  else if (bodyLen < 40 && !bug) {
    score -= 8;
    reasons.push('thin description');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    repro,
    soft_ask,
    looks_like_bug: bug
  };
}

/** Shared distinctive tokens used for title-overlap PR linkage. */
export function overlapTerms(text: string, limit = 8): string[] {
  return distinctiveTerms(text, limit);
}

export function lexicalOverlapScore(left: string, right: string): { score: number; shared: string[] } {
  const leftTerms = new Set(overlapTerms(left, 12));
  const rightTerms = new Set(overlapTerms(right, 12));
  if (leftTerms.size === 0 || rightTerms.size === 0) return { score: 0, shared: [] };
  const shared = [...leftTerms].filter((term) => rightTerms.has(term));
  const union = new Set([...leftTerms, ...rightTerms]);
  return { score: shared.length / union.size, shared };
}
