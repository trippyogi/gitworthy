import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { githubJson, GithubIssue } from '../lib/github.js';
import { shallowClone } from '../lib/git.js';
import { createEnvelope, Envelope } from './envelope.js';

const INTENT_LIMIT = "directory or string existence does not prove the issue's intent is satisfied; read both before making any public claim.";
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'should', 'would', 'could', 'please', 'issue', 'when', 'where', 'into']);

type Input = { repo: string; issue_number: number };

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    return entry.isDirectory() ? walk(full) : [full];
  }));
  return nested.flat();
}

function terms(issue: GithubIssue): string[] {
  const text = `${issue.title}\n${issue.body ?? ''}`;
  const pathLike = Array.from(text.matchAll(/[\w.-]+\/[\w./-]+/g)).map((match) => match[0]);
  const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  return Array.from(new Set([...pathLike, ...words.filter((word) => !STOP.has(word)).slice(0, 20)]));
}

export async function issue_vs_main(input: Input): Promise<Envelope> {
  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const candidates = terms(issue);
  const clone = await shallowClone(input.repo);
  try {
    const files = await walk(clone.dir);
    const treeMatches = files.map((file) => path.relative(clone.dir, file)).filter((relative) => candidates.some((term) => relative.toLowerCase().includes(term.toLowerCase()))).slice(0, 25);
    const grepMatches = [] as Array<Record<string, unknown>>;
    for (const file of files.slice(0, 2000)) {
      const relative = path.relative(clone.dir, file);
      const text = await readFile(file, 'utf8').catch(() => '');
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const term = candidates.find((candidate) => lines[index].toLowerCase().includes(candidate.toLowerCase()));
        if (term) grepMatches.push({ path: relative, line: index + 1, term, sample: lines[index].slice(0, 200) });
        if (grepMatches.length >= 10) break;
      }
      if (grepMatches.length >= 10) break;
    }
    const verdict_summary = treeMatches.length > 0 && grepMatches.length > 0 ? 'ask appears shipped on main, verify intent.' : treeMatches.length > 0 || grepMatches.length > 0 ? 'partial overlap found.' : 'no evidence on main.';
    return createEnvelope({
      verdict_summary,
      evidence: [{ issue: issue.number, title: issue.title, state: issue.state, labels: issue.labels.map((label) => label.name), comments: issue.comments, url: issue.html_url }, { tree_matches: treeMatches }, { grep_matches: grepMatches }],
      checked: [`fetched issue ${input.repo}#${input.issue_number}`, `shallow cloned ${input.repo}`, `searched candidate terms in tree and file contents`],
      not_checked: [INTENT_LIMIT],
      cached: false
    });
  } finally {
    await clone.cleanup();
  }
}
