import type { CaptureMode, CaptureTarget } from '../contracts/capture.js';
import { GitworthyError } from '../core/envelope.js';
import { githubJson } from './github.js';

type RepoVisibility = {
  full_name: string;
  html_url: string;
  private: boolean;
};

export async function captureTargetForRepoIssue(input: {
  repo: string;
  issue_number: number;
  capture_mode: CaptureMode;
}): Promise<CaptureTarget> {
  const repo = await loadRepoVisibility(input.repo);
  rejectPrivateUnlessLocal(repo, input.capture_mode);
  return {
    kind: 'repo_issue',
    input: input.repo,
    canonical: repo.full_name,
    issue_number: input.issue_number,
    html_url: `${repo.html_url}/issues/${input.issue_number}`,
    is_private: repo.private
  };
}

export async function captureTargetForRepo(input: {
  repo: string;
  capture_mode: CaptureMode;
}): Promise<CaptureTarget> {
  const repo = await loadRepoVisibility(input.repo);
  rejectPrivateUnlessLocal(repo, input.capture_mode);
  return {
    kind: 'repo',
    input: input.repo,
    canonical: repo.full_name,
    html_url: repo.html_url,
    is_private: repo.private
  };
}

export function captureTargetForOrg(org: string): CaptureTarget {
  return {
    kind: 'org',
    input: org,
    canonical: org,
    html_url: `https://github.com/${org}`,
    is_private: false
  };
}

async function loadRepoVisibility(repo: string): Promise<RepoVisibility> {
  return githubJson<RepoVisibility>(`/repos/${repo}`);
}

function rejectPrivateUnlessLocal(repo: RepoVisibility, captureMode: CaptureMode): void {
  if (!repo.private || captureMode === 'local_only') return;
  throw new GitworthyError({
    code: 'capture_private_repo_rejected',
    message: `Capture is only allowed for public repositories by default; ${repo.full_name} is private. Re-run with the local-only private override if you need a non-promotable local capture.`,
    not_checked: ['capture session was not started for a private repository']
  });
}
