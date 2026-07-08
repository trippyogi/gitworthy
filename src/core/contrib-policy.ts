import { readCache, writeCache } from '../lib/cache.js';
import { fetchRaw } from '../lib/github.js';
import { createEnvelope, Envelope } from './envelope.js';

const TTL = 24 * 60 * 60 * 1000;
const FILES = ['CONTRIBUTING.md', 'AGENTS.md', 'AI_POLICY.md', 'CODE_OF_CONDUCT.md', '.github/PULL_REQUEST_TEMPLATE.md', 'SECURITY.md'];
const CATEGORIES: Record<string, string[]> = {
  evidence_requirements: ['test', 'tests', 'proof', 'evidence', 'screenshot', 'screenshots', 'logs'],
  ai_assistance_policy: ['ai', 'agent', 'llm', 'generated'],
  pr_caps_or_rate_limits: ['limit', 'cap', 'one pr', 'pull request'],
  issue_first_or_alignment: ['issue first', 'discuss', 'alignment', 'before opening'],
  cla_requirement: ['cla', 'contributor license agreement', 'license agreement'],
  branch_naming: ['branch name', 'branch naming'],
  forbidden_pr_types: ['refactor-only', 'refactor only', 'formatting-only', 'drive-by'],
  contacts_or_channels: ['discord', 'contact', 'maintainer', 'channel']
};
const CATEGORY_PRIORITY: Record<string, number> = {
  forbidden_pr_types: 5,
  cla_requirement: 4,
  evidence_requirements: 3,
  pr_caps_or_rate_limits: 3,
  issue_first_or_alignment: 2,
  ai_assistance_policy: 1,
  branch_naming: 1,
  contacts_or_channels: 1
};

type Input = { repo: string; force_refresh?: boolean };
type CategoryMatch = { category: string; keyword: string; score: number };

function keywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  if (keyword === 'ai') return /(^|[^.@\w])ai([^\w]|$)/i;
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i');
}

function splitSections(text: string): string[] {
  return text.split(/\n{2,}|(?=^#{1,3}\s+)/m).map((section) => section.trim()).filter(Boolean);
}

function words(text: string): string[] {
  return text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

function excerpt(text: string, keyword: string): string {
  const allWords = words(text);
  const key = keyword.toLowerCase().split(/\s+/)[0];
  const index = Math.max(0, allWords.findIndex((word) => word.toLowerCase().includes(key)));
  return allWords.slice(Math.max(0, index - 12), Math.min(allWords.length, index + 28)).join(' ');
}

function scoreCategory(section: string, category: string, keywords: string[]): CategoryMatch | null {
  const heading = section.split('\n')[0] ?? '';
  const matches = keywords.filter((keyword) => keywordRegex(keyword).test(section));
  if (matches.length === 0) return null;
  const headingBonus = matches.some((keyword) => keywordRegex(keyword).test(heading)) ? 3 : 0;
  const categoryBonus = category === 'cla_requirement' && !/\bcla\b|contributor license agreement|license agreement/i.test(section) ? -10 : 0;
  const priorityBonus = CATEGORY_PRIORITY[category] ?? 0;
  return { category, keyword: matches[0], score: matches.length + headingBonus + categoryBonus + priorityBonus };
}

function bestCategory(section: string): CategoryMatch | null {
  const matches = Object.entries(CATEGORIES).map(([category, keywords]) => scoreCategory(section, category, keywords)).filter((match): match is CategoryMatch => match !== null && match.score > 0).sort((a, b) => b.score - a.score);
  if (matches.length === 0) return null;
  if (matches[1] && matches[0].score === matches[1].score) return { category: 'ambiguous', keyword: matches[0].keyword, score: matches[0].score };
  return matches[0];
}

export async function contrib_policy(input: Input): Promise<Envelope> {
  const cached = await readCache<Envelope>('contrib_policy', input, TTL, input.force_refresh);
  if (cached.hit) return { ...cached.value, cached: true, fetched_at: cached.fetched_at };
  const fetched_at = new Date().toISOString();
  const evidence: Array<Record<string, unknown>> = [];
  const checked: string[] = [];
  const not_checked = ['policy extraction is keyword and heading based; ambiguous sections are reported rather than inferred.'];
  const seen = new Set<string>();
  for (const file of FILES) {
    let text: string | null = null;
    let branch = 'main';
    text = await fetchRaw(input.repo, branch, file);
    if (text === null) {
      branch = 'master';
      text = await fetchRaw(input.repo, branch, file);
    }
    checked.push(`looked for ${file} on main and master`);
    if (!text) continue;
    for (const section of splitSections(text)) {
      const match = bestCategory(section);
      if (!match) continue;
      const rawExcerpt = excerpt(section, match.keyword);
      const key = `${file}:${rawExcerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({ category: match.category, file, url: `https://github.com/${input.repo}/blob/${branch}/${file}`, excerpt: rawExcerpt, ambiguous: match.category === 'ambiguous' });
    }
  }
  if (evidence.length === 0) not_checked.push('no contribution policy excerpts were found in the checked files.');
  const signalLabel = evidence.length === 1 ? 'signal' : 'signals';
  const envelope = createEnvelope({ verdict_summary: evidence.length > 0 ? `found ${evidence.length} contribution policy ${signalLabel}.` : 'no contribution policy signals found.', evidence, checked, not_checked, cached: false, fetched_at });
  await writeCache('contrib_policy', input, envelope, fetched_at);
  return envelope;
}
