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
  return Array.from(new Set([...explicitPathTerms(issue), ...contentTerms(issue)]));
}

function explicitPathTerms(issue: GithubIssue): string[] {
  const text = `${issue.title}\n${issue.body ?? ''}`;
  return Array.from(text.matchAll(/[\w.-]+\/[\w./-]+/g)).map((match) => match[0]);
}

function pathLiteralTokens(issue: GithubIssue): Set<string> {
  return new Set(explicitPathTerms(issue).flatMap((term) => term.toLowerCase().split(/[^a-z0-9_-]+/)).filter(Boolean));
}

function contentTerms(issue: GithubIssue): string[] {
  const literalTokens = pathLiteralTokens(issue);
  const text = `${issue.title}\n${issue.body ?? ''}`;
  return distinctiveTerms(text, 20).filter((term) => !literalTokens.has(term));
}

function pathTerms(issue: GithubIssue): string[] {
  const explicit = explicitPathTerms(issue);
  return [...explicit, ...inferredExampleTerms(issue)];
}

function inferredExampleTerms(issue: GithubIssue): string[] {
  const titleWords = distinctiveTerms(issue.title, 10);
  return issue.title.toLowerCase().includes('example') ? titleWords.filter((word) => !isGenericTerm(word) && word !== 'python').map((word) => `example-apps/${word}`) : [];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function pathMatchesIntent(filePath: string, intentPath: string): boolean {
  const normalizedFile = normalizePath(filePath).toLowerCase();
  const normalizedIntent = normalizePath(intentPath).toLowerCase();
  return normalizedFile === normalizedIntent || normalizedFile.startsWith(`${normalizedIntent}/`);
}

export async function issue_vs_main(input: Input): Promise<Envelope> {
  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const candidates = terms(issue);
  const grepCandidates = contentTerms(issue);
  const exactPathTerms = pathTerms(issue);
  const inferredIntentTerms = inferredExampleTerms(issue);
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
        const term = grepCandidates.find((candidate) => lines[index].toLowerCase().includes(candidate.toLowerCase()));
        if (term) grepMatches.push({ path: relative, line: index + 1, term, sample: lines[index].slice(0, 200) });
        if (grepMatches.length >= 10) break;
      }
      if (grepMatches.length >= 10) break;
    }
    const pathIntentMatched = exactPathTerms.length > 0 && treeMatches.some((relative) => exactPathTerms.some((term) => relative.toLowerCase().includes(term.toLowerCase())));
    const inferredIntentMatched = inferredIntentTerms.length > 0 && treeMatches.some((relative) => inferredIntentTerms.some((term) => relative.toLowerCase().includes(term.toLowerCase())));
    const contentIntentMatched = grepMatches.some((match) => {
      const matchPath = match.path;
      return typeof matchPath === 'string' && exactPathTerms.some((term) => pathMatchesIntent(matchPath, term));
    });
    const shippedSignal = inferredIntentMatched || (pathIntentMatched && contentIntentMatched);
    const verdict_summary = shippedSignal ? 'ask appears shipped on main, verify intent.' : treeMatches.length > 0 || grepMatches.length > 0 ? 'partial overlap found.' : 'no evidence on main.';
    return createEnvelope({
      verdict_summary,
      evidence: [{ issue: issue.number, title: issue.title, state: issue.state, labels: issue.labels.map((label) => label.name), comments: issue.comments, url: issue.html_url }, { tree_matches: treeMatches }, { grep_matches: grepMatches }],
      signals: shippedSignal ? ['shipped'] : [],
      checked: [`fetched issue ${input.repo}#${input.issue_number}`, `shallow cloned ${input.repo}`, `searched candidate terms in tree and file contents`],
      not_checked: [INTENT_LIMIT],
      cached: false
    });
  } finally {
    await clone.cleanup();
  }
}
