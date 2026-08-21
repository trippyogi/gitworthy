import { createHash } from 'node:crypto';

export type FingerprintLinkedPr = {
  number: number;
  state: string;
  draft?: boolean;
  merged?: boolean;
  updated_at?: string;
  head_sha?: string;
  closes_issue?: boolean;
};

export type FingerprintInput = {
  repo: string;
  issue_number: number;
  issue_state?: string;
  issue_updated_at?: string;
  repo_head_sha?: string;
  assignees?: string[];
  linked_prs?: FingerprintLinkedPr[];
  contribution_policy?: {
    claim_required?: boolean;
    no_pr_path?: boolean;
  };
};

function canonicalize(input: FingerprintInput): string {
  const linked = [...(input.linked_prs ?? [])]
    .map((pr) => ({
      number: pr.number,
      state: pr.state,
      draft: pr.draft === true,
      merged: pr.merged === true,
      updated_at: pr.updated_at ?? null,
      head_sha: pr.head_sha ?? null,
      closes_issue: pr.closes_issue === true
    }))
    .sort((left, right) => left.number - right.number || left.state.localeCompare(right.state));

  const payload = {
    repo: input.repo,
    issue_number: input.issue_number,
    issue_state: input.issue_state ?? null,
    issue_updated_at: input.issue_updated_at ?? null,
    repo_head_sha: input.repo_head_sha ?? null,
    assignees: [...(input.assignees ?? [])].map((login) => login.toLowerCase()).sort(),
    linked_prs: linked,
    contribution_policy: {
      claim_required: input.contribution_policy?.claim_required === true,
      no_pr_path: input.contribution_policy?.no_pr_path === true
    }
  };
  return JSON.stringify(payload);
}

/** SHA-256 of canonical target-state facts. Collections are sorted before hashing. */
export function stateFingerprint(input: FingerprintInput): string {
  return createHash('sha256').update(canonicalize(input)).digest('hex');
}
