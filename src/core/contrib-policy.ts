import { readCache, writeCache } from '../lib/cache.js';
import { fetchRaw } from '../lib/github.js';
import { createEnvelope, Envelope } from './envelope.js';

const TTL = 24 * 60 * 60 * 1000;
const FILES = ['CONTRIBUTING.md', 'AGENTS.md', 'AI_POLICY.md', 'CODE_OF_CONDUCT.md', '.github/PULL_REQUEST_TEMPLATE.md', 'SECURITY.md'];
const CATEGORIES: Record<string, string[]> = {
  evidence_requirements: ['test', 'proof', 'evidence', 'screenshot', 'logs'],
  ai_assistance_policy: ['ai', 'agent', 'llm', 'generated'],
  pr_caps_or_rate_limits: ['limit', 'cap', 'one pr', 'pull request'],
  issue_first_or_alignment: ['issue first', 'discuss', 'alignment', 'before opening'],
  cla_requirement: ['cla', 'license agreement'],
  branch_naming: ['branch name', 'branch naming'],
  forbidden_pr_types: ['refactor-only', 'refactor only', 'formatting-only', 'drive-by'],
  contacts_or_channels: ['discord', 'contact', 'maintainer', 'channel']
};

type Input = { repo: string; force_refresh?: boolean };

function excerpt(text: string, keyword: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const index = words.findIndex((word) => word.toLowerCase().includes(keyword.toLowerCase().split(' ')[0]));
  const slice = words.slice(Math.max(0, index - 12), Math.min(words.length, index + 28));
  return slice.join(' ');
}

export async function contrib_policy(input: Input): Promise<Envelope> {
  const cached = await readCache<Envelope>('contrib_policy', input, TTL, input.force_refresh);
  if (cached.hit) return { ...cached.value, cached: true, fetched_at: cached.fetched_at };
  const fetched_at = new Date().toISOString();
  const evidence: Array<Record<string, unknown>> = [];
  const checked: string[] = [];
  const not_checked = ['policy extraction is keyword and heading based; ambiguous sections are reported rather than inferred.'];
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
    const lower = text.toLowerCase();
    for (const [category, keywords] of Object.entries(CATEGORIES)) {
      const keyword = keywords.find((item) => lower.includes(item));
      if (keyword) {
        evidence.push({ category, file, url: `https://github.com/${input.repo}/blob/${branch}/${file}`, excerpt: excerpt(text, keyword), ambiguous: false });
      }
    }
  }
  if (evidence.length === 0) not_checked.push('no contribution policy excerpts were found in the checked files.');
  const signalLabel = evidence.length === 1 ? 'signal' : 'signals';
  const envelope = createEnvelope({ verdict_summary: evidence.length > 0 ? `found ${evidence.length} contribution policy ${signalLabel}.` : 'no contribution policy signals found.', evidence, checked, not_checked, cached: false, fetched_at });
  await writeCache('contrib_policy', input, envelope, fetched_at);
  return envelope;
}
