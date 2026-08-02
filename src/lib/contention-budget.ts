/** Evidence budget + provenance footer for contention analysis (GW-041 / C5). */

export const DEFAULT_CONTENTION_BUDGET_BYTES = 1_500_000;
export const DEFAULT_MAX_DIFF_BYTES_PER_PR = 250_000;

export type ContentionBudget = {
  budgetBytes: number;
  usedBytes: number;
  artifactsRead: number;
  truncated: boolean;
  truncateReasons: string[];
};

export function createContentionBudget(budgetBytes = DEFAULT_CONTENTION_BUDGET_BYTES): ContentionBudget {
  return {
    budgetBytes,
    usedBytes: 0,
    artifactsRead: 0,
    truncated: false,
    truncateReasons: []
  };
}

export function tryConsumeBudget(budget: ContentionBudget, bytes: number, artifactLabel: string): {
  allowed: number;
  truncated: boolean;
} {
  const remaining = Math.max(0, budget.budgetBytes - budget.usedBytes);
  if (remaining <= 0) {
    budget.truncated = true;
    budget.truncateReasons.push(`budget exhausted before ${artifactLabel}`);
    return { allowed: 0, truncated: true };
  }
  const allowed = Math.min(bytes, remaining);
  budget.usedBytes += allowed;
  budget.artifactsRead += 1;
  if (allowed < bytes) {
    budget.truncated = true;
    budget.truncateReasons.push(`${artifactLabel} truncated to ${allowed} of ${bytes} bytes`);
    return { allowed, truncated: true };
  }
  return { allowed, truncated: false };
}

export function provenanceFooter(input: {
  claimCount: number;
  issueBytes: number;
  discussionBytes: number;
  commentCount: number;
  verdictCount: number;
  budget: ContentionBudget;
}): string {
  const diffKb = (input.budget.usedBytes / 1024).toFixed(1);
  const issueKb = (input.issueBytes / 1024).toFixed(1);
  const discKb = (input.discussionBytes / 1024).toFixed(1);
  const trunc = input.budget.truncated
    ? ` Truncated: ${input.budget.truncateReasons.slice(0, 3).join('; ') || 'budget'}. Affected verdicts are low_confidence.`
    : '';
  return (
    `Contention analysis: ${input.claimCount} PRs and 1 issue in this complex. `
    + `Each diff read against the issue. Working set: ${diffKb} kB PR diffs, `
    + `${issueKb} kB issue text, ${discKb} kB discussion (${input.commentCount} comments), `
    + `${input.verdictCount} verdicts. Verdicts reflect diff content, not PR titles.`
    + trunc
  );
}
