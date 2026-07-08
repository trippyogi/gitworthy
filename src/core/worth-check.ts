import { branch_scan } from './branch-scan.js';
import { dupe_cluster } from './dupe-cluster.js';
import { issue_vs_main } from './issue-vs-main.js';
import { release_gap } from './release-gap.js';
import { contrib_policy } from './contrib-policy.js';
import { createEnvelope, Envelope, GitworthyError } from './envelope.js';

type Input = { repo: string; issue_number: number; npm_package?: string };
type SubResult = { name: string; ok: true; result: Envelope } | { name: string; ok: false; error: { code: string; message: string; not_checked: string[] } };

type WorthEnvelope = Envelope & { verdict: 'ACT' | 'VERIFY' | 'SKIP'; reasons: string[]; sub_results: SubResult[] };

function err(name: string, error: unknown): SubResult {
  if (error instanceof GitworthyError) return { name, ok: false, error: { code: error.code, message: error.message, not_checked: error.not_checked } };
  return { name, ok: false, error: { code: 'unknown_error', message: error instanceof Error ? error.message : String(error), not_checked: ['sub-check failed with an unknown error.'] } };
}

export async function worth_check(input: Input): Promise<WorthEnvelope> {
  const sub_results: SubResult[] = [];
  let issueKeywords = [String(input.issue_number)];
  try {
    const issue = await issue_vs_main(input);
    sub_results.push({ name: 'issue_vs_main', ok: true, result: issue });
    const issueEvidence = issue.evidence[0] as { title?: string };
    issueKeywords = (issueEvidence.title?.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? issueKeywords).slice(0, 6);
  } catch (error) {
    sub_results.push(err('issue_vs_main', error));
  }
  try { sub_results.push({ name: 'branch_scan', ok: true, result: await branch_scan({ repo: input.repo, keywords: issueKeywords }) }); } catch (error) { sub_results.push(err('branch_scan', error)); }
  if (input.npm_package) {
    try { sub_results.push({ name: 'release_gap', ok: true, result: await release_gap({ repo: input.repo, npm_package: input.npm_package }) }); } catch (error) { sub_results.push(err('release_gap', error)); }
  }
  try { sub_results.push({ name: 'dupe_cluster', ok: true, result: await dupe_cluster({ repo: input.repo, issue_number: input.issue_number }) }); } catch (error) { sub_results.push(err('dupe_cluster', error)); }
  try { sub_results.push({ name: 'contrib_policy', ok: true, result: await contrib_policy({ repo: input.repo }) }); } catch (error) { sub_results.push(err('contrib_policy', error)); }

  const reasons: string[] = [];
  const errors = sub_results.filter((result) => !result.ok);
  for (const result of sub_results) {
    if (!result.ok) reasons.push(`${result.name} errored: ${result.error.message}`);
    if (result.ok && /recent in-flight|shipped|duplicate candidate|main and npm are equal/.test(result.result.verdict_summary)) reasons.push(`${result.name}: ${result.result.verdict_summary}`);
  }
  let verdict: 'ACT' | 'VERIFY' | 'SKIP' = 'ACT';
  if (errors.length > 0) verdict = 'VERIFY';
  else if (reasons.some((reason) => /recent in-flight|shipped|duplicate candidate|main and npm are equal/.test(reason))) verdict = 'SKIP';
  else if (reasons.length > 0) verdict = 'VERIFY';
  const base = createEnvelope({
    verdict_summary: verdict === 'ACT' ? 'ACT: no blocking evidence found by completed checks.' : verdict === 'SKIP' ? 'SKIP: blocking evidence was found by completed checks.' : 'VERIFY: mixed signals or sub-check errors require human review.',
    evidence: [],
    checked: sub_results.filter((result) => result.ok).map((result) => result.name),
    not_checked: [...new Set(sub_results.flatMap((result) => result.ok ? result.result.not_checked : result.error.not_checked))],
    cached: false
  });
  return { ...base, verdict, reasons, sub_results };
}
