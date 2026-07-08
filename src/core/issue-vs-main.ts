import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { githubJson, GithubIssue } from '../lib/github.js';
import { shallowClone } from '../lib/git.js';
import { createEnvelope, Envelope } from './envelope.js';
import { distinctiveTerms, isGenericTerm } from './terms.js';

const INTENT_LIMIT = "directory or string existence does not prove the issue's intent is satisfied; read both before making any public claim.";
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
  return Array.from(new Set([...pathLike, ...distinctiveTerms(text, 20)]));
}

function pathTerms(issue: GithubIssue): string[] {
  const text = `${issue.title}\n${issue.body ?? ''}`;
  const explicit = Array.from(text.matchAll(/[\w.-]+\/[\w./-]+/g)).map((match) => match[0]);
  const titleWords = distinctiveTerms(issue.title, 10);
  const inferredExamples = issue.title.toLowerCase().includes('example') ? titleWords.filter((word) => !isGenericTerm(word) && word !== 'python').map((word) => `example-apps/${word}`) : [];
  return [...explicit, ...inferredExamples];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

export async function issue_vs_main(input: Input): Promise<Envelope> {
  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const candidates = terms(issue);
  const exactPathTerms = pathTerms(issue);
  const clone = await shallowClone(input.repo);
  try {
    const files = await walk(clone.dir);
    const allTreeMatches = files.map((file) => normalizePath(path.relative(clone.dir, file))).filter((relative) => candidates.some((term) => relative.toLowerCase().includes(term.toLowerCase())));
    const treeMatches = allTreeMatches.sort((left, right) => Number(exactPathTerms.some((term) => right.toLowerCase().includes(term.toLowerCase()))) - Number(exactPathTerms.some((term) => left.toLowerCase().includes(term.toLowerCase())))).slice(0, 50);
    const grepMatches = [] as Array<Record<string, unknown>>;
    for (const file of files.slice(0, 2000)) {
      const relative = normalizePath(path.relative(clone.dir, file));
      const text = await readFile(file, 'utf8').catch(() => '');
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const term = candidates.find((candidate) => lines[index].toLowerCase().includes(candidate.toLowerCase()));
        if (term) grepMatches.push({ path: relative, line: index + 1, term, sample: lines[index].slice(0, 200) });
        if (grepMatches.length >= 10) break;
      }
      if (grepMatches.length >= 10) break;
    }
    const pathIntentMatched = exactPathTerms.length > 0 && treeMatches.some((relative) => exactPathTerms.some((term) => relative.toLowerCase().includes(term.toLowerCase())));
    const verdict_summary = pathIntentMatched && grepMatches.length > 0 ? 'ask appears shipped on main, verify intent.' : treeMatches.length > 0 || grepMatches.length > 0 ? 'partial overlap found.' : 'no evidence on main.';
    return createEnvelope({
      verdict_summary,
      evidence: [{ issue: issue.number, title: issue.title, state: issue.state, labels: issue.labels.map((label) => label.name), comments: issue.comments, url: issue.html_url }, { tree_matches: treeMatches }, { grep_matches: grepMatches }],
      signals: pathIntentMatched && grepMatches.length > 0 ? ['shipped'] : [],
      checked: [`fetched issue ${input.repo}#${input.issue_number}`, `shallow cloned ${input.repo}`, `searched candidate terms in tree and file contents`],
      not_checked: [INTENT_LIMIT],
      cached: false
    });
  } finally {
    await clone.cleanup();
  }
}
