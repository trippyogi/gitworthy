import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { githubJson, GithubIssue } from '../lib/github.js';
import { listCloneFiles, shallowClone } from '../lib/git.js';
import { assessRepro, looksLikeBug } from './candidate-quality.js';
import { createEnvelope, Envelope } from './envelope.js';
import { distinctiveTerms, isGenericTerm } from './terms.js';

const INTENT_LIMIT = "directory or string existence does not prove the issue's intent is satisfied; read both before making any public claim.";
const FUZZY_SKIP = 'issue_vs_main tree/grep skipped: no concrete path terms (src/…, extensions/…, or ≥2 path-like tokens); assessed repro signals only.';
type Input = { repo: string; issue_number: number };

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

function terms(issue: GithubIssue): string[] {
  return Array.from(new Set([...explicitPathTerms(issue), ...contentTerms(issue)]));
}

/** True when the issue names concrete code paths worth cloning/walking. */
export function hasConcretePathTerms(issue: Pick<GithubIssue, 'title' | 'body'>): boolean {
  const text = `${issue.title}\n${issue.body ?? ''}`;
  if (/\b(?:src|extensions?|packages?|lib|apps?|server|client|plugins?|internal|crates?)\/[\w./-]+/i.test(text)) return true;
  const paths = explicitPathTerms(issue as GithubIssue).filter((item) => !/^https?:\/\//i.test(item) && item.includes('/'));
  if (paths.some((item) => item.split('/').filter(Boolean).length >= 2)) return true;
  if (paths.length >= 2) return true;
  return false;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function pathMatchesIntent(filePath: string, intentPath: string): boolean {
  const normalizedFile = normalizePath(filePath).toLowerCase();
  const normalizedIntent = normalizePath(intentPath).toLowerCase();
  return normalizedFile === normalizedIntent || normalizedFile.startsWith(`${normalizedIntent}/`);
}

function issueMetaEvidence(issue: GithubIssue, repro: ReturnType<typeof assessRepro>, bugMissingRepro: boolean) {
  return {
    issue: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
    comments: issue.comments,
    url: issue.html_url,
    repro,
    needs_repro: bugMissingRepro
  };
}

export async function issue_vs_main(input: Input): Promise<Envelope> {
  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const repro = assessRepro(issue.body);
  const bugMissingRepro = looksLikeBug({ title: issue.title, body: issue.body, labels: issue.labels.map((label) => label.name) }) && repro === 'missing';
  const needsReproSignals = bugMissingRepro ? ['needs_repro' as const] : [];
  const inferredIntentTerms = inferredExampleTerms(issue);
  const concrete = hasConcretePathTerms(issue) || inferredIntentTerms.length > 0;

  if (!concrete) {
    return createEnvelope({
      verdict_summary: bugMissingRepro
        ? 'bug-shaped issue lacks reproduction steps; verify before investing.'
        : 'no concrete path terms; skipped main tree/grep.',
      evidence: [
        issueMetaEvidence(issue, repro, bugMissingRepro),
        { tree_matches: [] },
        { grep_matches: [] },
        { kind: 'issue_vs_main_perf', mode: 'repro_only', clone_cached: null, file_list_cached: null }
      ],
      signals: needsReproSignals,
      checked: [`fetched issue ${input.repo}#${input.issue_number}`, 'assessed reproduction-step signals in the issue body', 'skipped tree/grep (no concrete path terms)'],
      not_checked: [INTENT_LIMIT, FUZZY_SKIP],
      cached: false
    });
  }

  const candidates = terms(issue);
  const grepCandidates = contentTerms(issue);
  const exactPathTerms = pathTerms(issue);
  const clone = await shallowClone(input.repo);
  try {
    const listed = await listCloneFiles(input.repo);
    const root = listed.dir;
    const files = listed.files;
    const allTreeMatches = files.map((file) => normalizePath(path.relative(root, file))).filter((relative) => candidates.some((term) => relative.toLowerCase().includes(term.toLowerCase())));
    const treeMatches = allTreeMatches.sort((left, right) => Number(exactPathTerms.some((term) => right.toLowerCase().includes(term.toLowerCase()))) - Number(exactPathTerms.some((term) => left.toLowerCase().includes(term.toLowerCase())))).slice(0, 50);
    const grepMatches = [] as Array<Record<string, unknown>>;
    for (const file of files.slice(0, 2000)) {
      const relative = normalizePath(path.relative(root, file));
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
    const signals = [
      ...(shippedSignal ? ['shipped' as const] : []),
      ...needsReproSignals
    ];
    const verdict_summary = shippedSignal
      ? 'ask appears shipped on main, verify intent.'
      : treeMatches.length > 0 || grepMatches.length > 0
        ? 'partial overlap found.'
        : bugMissingRepro
          ? 'bug-shaped issue lacks reproduction steps; verify before investing.'
          : 'no evidence on main.';
    return createEnvelope({
      verdict_summary,
      evidence: [
        issueMetaEvidence(issue, repro, bugMissingRepro),
        { tree_matches: treeMatches },
        { grep_matches: grepMatches },
        { kind: 'issue_vs_main_perf', mode: 'full', clone_cached: clone.cached, file_list_cached: listed.cached }
      ],
      signals,
      checked: [
        `fetched issue ${input.repo}#${input.issue_number}`,
        clone.cached ? `reused pooled shallow clone of ${input.repo}` : `shallow cloned ${input.repo}`,
        listed.cached ? `reused cached file list for ${input.repo}` : `walked file list for ${input.repo}`,
        `searched candidate terms in tree and file contents`,
        'assessed reproduction-step signals in the issue body'
      ],
      not_checked: [INTENT_LIMIT],
      cached: false
    });
  } finally {
    await clone.cleanup();
  }
}
