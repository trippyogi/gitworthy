/** Local draft scope excess check (GW-041 check-scope). */

import { readFile } from 'node:fs/promises';
import { execa } from 'execa';
import { analyzeGaps } from './gap-analysis.js';
import { extractTouchedPaths, extractTouchedSymbols } from '../lib/github-diff.js';
import { GIT_SUBPROCESS_TIMEOUT_MS } from '../lib/git.js';
import { githubJson, GithubIssue } from '../lib/github.js';
import { createEnvelope, type Envelope } from './envelope.js';
import { ContentionReportSchema, type ContentionGap } from '../contracts/contention.js';
import { createContentionBudget, provenanceFooter } from '../lib/contention-budget.js';

export type CheckScopeInput = {
  repo: string;
  issue_number: number;
  /** Unified diff file path. When omitted, uses `git diff` in cwd (or diff_cwd). */
  diff_path?: string;
  diff_cwd?: string;
  base_ref?: string;
};

export type CheckScopeResult = Envelope & {
  contention_gaps: ContentionGap[];
  draft: { paths: string[]; symbols: string[] };
  scope_excess: boolean;
};

export async function check_scope(input: CheckScopeInput): Promise<CheckScopeResult> {
  const loaded = input.diff_path
    ? { text: await readFile(input.diff_path, 'utf8'), error: undefined as string | undefined }
    : await readWorkingTreeDiff(input.diff_cwd ?? process.cwd(), input.base_ref);
  const diffText = loaded.text;
  const diffError = loaded.error;
  const paths = extractTouchedPaths(diffText);
  const symbols = extractTouchedSymbols(diffText);
  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const labels = (issue.labels ?? []).map((label) => label.name);
  const gaps = diffError
    ? []
    : analyzeGaps({
      issueTitle: issue.title,
      issueBody: issue.body,
      labels,
      claims: [],
      classes: [],
      draft: { paths, symbols }
    }).filter((gap) => gap.kind === 'scope_excess');

  const budget = createContentionBudget();
  const footer = provenanceFooter({
    claimCount: 0,
    issueBytes: Buffer.byteLength(`${issue.title}\n${issue.body ?? ''}`, 'utf8'),
    discussionBytes: 0,
    commentCount: 0,
    verdictCount: gaps.length,
    budget
  });

  const scope_excess = gaps.length > 0;
  const emptyDiff = !diffError && diffText.trim().length === 0;
  const verdict_summary = diffError
    ? `scope check incomplete: ${diffError}`
    : scope_excess
      ? `scope_excess: draft touches ${gaps[0]?.symbols.slice(0, 6).join(', ') || 'paths'} outside the issue ask — split follow-ups, do not bundle.`
      : emptyDiff
        ? 'scope check incomplete: working tree diff was empty (nothing staged/unstaged, or wrong cwd).'
        : 'draft scope looks within identifiers named in the issue (heuristic).';
  const envelope = createEnvelope({
    verdict_summary,
    evidence: [
      {
        kind: 'scope_check',
        repo: input.repo,
        issue_number: input.issue_number,
        paths,
        symbols,
        gaps,
        diff_error: diffError,
        provenance_footer: footer
      }
    ],
    signals: [],
    checked: [
      `loaded issue ${input.repo}#${input.issue_number}`,
      input.diff_path ? `read diff from ${input.diff_path}` : 'attempted working tree git diff',
      ...(diffError ? [] : ['compared draft symbols/paths to issue-named identifiers'])
    ],
    not_checked: [
      ...(diffError ? [`draft diff was not checked because: ${diffError}`] : []),
      ...(emptyDiff ? ['draft diff was empty; scope_excess was not evaluated.'] : []),
      'scope_excess is a VERIFY-grade heuristic (no tree-sitter; identifiers come from issue backticks / _snake names).',
      'does not prove behavioral correctness of the draft.'
    ],
    cached: false
  });

  return {
    ...envelope,
    contention_gaps: gaps,
    draft: { paths, symbols },
    scope_excess,
    contention: ContentionReportSchema.parse({
      contention_version: 1,
      state: 'uncontested',
      claims: [],
      equivalence_classes: [],
      gaps,
      provenance: {
        bytes_read: Buffer.byteLength(diffText, 'utf8'),
        artifacts_read: diffError ? 0 : 1,
        truncated: false,
        verdict_count: gaps.length,
        budget_bytes: budget.budgetBytes,
        footer
      },
      low_confidence: Boolean(diffError) || emptyDiff || gaps.some((gap) => gap.low_confidence)
    })
  } as CheckScopeResult & { contention: unknown };
}

async function readWorkingTreeDiff(cwd: string, baseRef?: string): Promise<{ text: string; error?: string }> {
  try {
    if (baseRef) {
      const { stdout } = await execa('git', ['diff', `${baseRef}...HEAD`], { cwd, timeout: GIT_SUBPROCESS_TIMEOUT_MS });
      return { text: stdout };
    }
    const staged = await execa('git', ['diff', '--cached'], { cwd, timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    const unstaged = await execa('git', ['diff'], { cwd, timeout: GIT_SUBPROCESS_TIMEOUT_MS });
    return { text: `${staged.stdout}\n${unstaged.stdout}`.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: '', error: message };
  }
}
