import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { branch_scan, contrib_policy, dupe_cluster, issue_vs_main, release_gap, worth_check } from '../src/core/index.js';

type Case = {
  id: number;
  name: string;
  function: 'branch_scan' | 'issue_vs_main' | 'release_gap' | 'dupe_cluster' | 'contrib_policy' | 'worth_check';
  input: Record<string, unknown>;
  expect: Record<string, unknown>;
  note?: string;
  time_sensitive?: boolean;
};

type Row = { id: number; name: string; status: 'passed' | 'failed' | 'drifted' | 'blocked'; detail: string };

const runners = { branch_scan, issue_vs_main, release_gap, dupe_cluster, contrib_policy, worth_check } as const;

function textOf(value: unknown): string {
  return JSON.stringify(value).toLowerCase();
}

function fixtureJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/\u2014/g, '-');
}

function includes(value: unknown, needle: unknown): boolean {
  return textOf(value).includes(String(needle).toLowerCase());
}

function branchNames(value: Record<string, unknown>): string[] {
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  return evidence.map((item) => typeof item === 'object' && item !== null && 'branch' in item ? String((item as { branch: unknown }).branch) : '').filter(Boolean).sort();
}

function npmVersion(value: Record<string, unknown>): string | undefined {
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const packageEvidence = evidence.find((item) => typeof item === 'object' && item !== null && 'package' in item && 'version' in item) as { version?: unknown } | undefined;
  return typeof packageEvidence?.version === 'string' ? packageEvidence.version : undefined;
}

function positiveWorldChange(result: Record<string, unknown>, previous: Record<string, unknown> | null, spec: Case): boolean {
  if (!previous) return false;
  if (spec.function === 'branch_scan') return JSON.stringify(branchNames(result)) !== JSON.stringify(branchNames(previous));
  if (spec.function === 'release_gap') return npmVersion(result) !== npmVersion(previous);
  if (spec.function === 'worth_check') return includes(result, 'branch_scan') && textOf(result) !== textOf(previous);
  return false;
}

function evaluate(result: Record<string, unknown>, spec: Case, previous: Record<string, unknown> | null): Row {
  const expect = spec.expect;
  const failures: string[] = [];
  if (typeof expect.signal === 'string' && !(result.signals as string[] | undefined)?.includes(expect.signal)) failures.push(`missing signal ${expect.signal}`);
  if (typeof expect.no_signal === 'string' && (result.signals as string[] | undefined)?.includes(expect.no_signal)) failures.push(`unexpected signal ${expect.no_signal}`);
  if (typeof expect.verdict === 'string' && result.verdict !== expect.verdict) failures.push(`expected verdict ${expect.verdict}, observed ${String(result.verdict)}`);
  if (typeof expect.summary_contains === 'string' && !String(result.verdict_summary).toLowerCase().includes(expect.summary_contains.toLowerCase())) failures.push(`summary missing ${expect.summary_contains}`);
  if (typeof expect.evidence_contains === 'string' && !includes(result, expect.evidence_contains)) failures.push(`evidence missing ${expect.evidence_contains}`);
  if (Array.isArray(expect.evidence_contains_all)) for (const needle of expect.evidence_contains_all) if (!includes(result, needle)) failures.push(`evidence missing ${needle}`);
  if (!Array.isArray(result.checked) || result.checked.length === 0) failures.push('checked is empty');
  if (!Array.isArray(result.not_checked) || result.not_checked.length === 0) failures.push('not_checked is empty');
  if (failures.length === 0) return { id: spec.id, name: spec.name, status: 'passed', detail: 'mechanism matched expected signal' };
  const drifted = spec.time_sensitive === true && positiveWorldChange(result, previous, spec);
  return { id: spec.id, name: spec.name, status: drifted ? 'drifted' : 'failed', detail: failures.join('; ') };
}

async function main(): Promise<void> {
  const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8')) as Case[];
  await mkdir('fixtures', { recursive: true });
  const rows: Row[] = [];
  for (const item of cases) {
    try {
      const fixturePath = path.join('fixtures', `case-${item.id}.json`);
      const previous = await readFile(fixturePath, 'utf8').then((content) => JSON.parse(content) as Record<string, unknown>).catch(() => null);
      const result = await runners[item.function](item.input as never) as Record<string, unknown>;
      rows.push(evaluate(result, item, previous));
      await writeFile(fixturePath, `${fixtureJson(result)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const tokenBlocked = /GITHUB_TOKEN|required for this GitHub API check|rate limit/i.test(message);
      rows.push({ id: item.id, name: item.name, status: tokenBlocked ? 'blocked' : 'failed', detail: message });
    }
  }
  const passed = rows.filter((row) => row.status === 'passed').length;
  const drifted = rows.filter((row) => row.status === 'drifted').length;
  const blocked = rows.filter((row) => row.status === 'blocked').length;
  const failed = rows.filter((row) => row.status === 'failed').length;
  console.log('id status  name');
  for (const row of rows) console.log(`${row.id}  ${row.status.padEnd(7)} ${row.name}: ${row.detail}`);
  console.log(`summary passed=${passed} drifted=${drifted} blocked=${blocked} failed=${failed}`);
  if (failed > 0 || blocked > 0 || passed + drifted < 7) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
