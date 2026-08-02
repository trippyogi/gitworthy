/**
 * Suite runner for frozen / live / private eval (GW-021) with optional offline replay (GW-022).
 *
 * Usage:
 *   pnpm eval:frozen
 *   pnpm eval:live
 *   pnpm eval:private
 *   pnpm eval                 → compatibility shim (see run-eval.ts)
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EvalCaseCatalogSchema,
  EvalCaseSchema,
  EvalSuiteReportSchema,
  type EvalCase,
  type EvalSuite,
  type EvalSuiteReport
} from '../src/contracts/eval.js';
import { packageVersion } from '../src/lib/package-meta.js';
import { installProviderReplay, withIsolatedCacheDirs } from '../src/lib/provider-install.js';
import { ProviderReplayError } from '../src/lib/provider-replay.js';
import { classifyThrownError, evaluateFrozen, evaluateLive, type EvalRow } from './lib/evaluate.js';
import { evalRoot, fixtureJson, resolveProviderFixturesPath, runners } from './lib/shared.js';

type LegacyLiveCase = {
  id: number;
  name: string;
  function: EvalCase['function'];
  input: Record<string, unknown>;
  expect?: Record<string, unknown>;
  note?: string;
  time_sensitive?: boolean;
};

function parseArgs(argv: string[]): {
  suite: EvalSuite;
  updateSnapshots: boolean;
  allowPrivate: boolean;
} {
  const suiteArg = argv.find((arg) => arg.startsWith('--suite='))?.slice('--suite='.length)
    ?? argv[argv.indexOf('--suite') + 1];
  const suite = (suiteArg ?? 'live') as EvalSuite;
  if (suite !== 'frozen' && suite !== 'live' && suite !== 'private') {
    throw new Error(`Unknown suite "${suite}". Expected frozen|live|private.`);
  }
  return {
    suite,
    updateSnapshots: argv.includes('--update-snapshots') || argv.includes('--update-fixtures'),
    allowPrivate: argv.includes('--allow-private')
  };
}

async function loadFrozenCases(): Promise<Array<{ caseFile: string; spec: EvalCase }>> {
  const dir = path.join(evalRoot, 'frozen', 'cases');
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  const out: Array<{ caseFile: string; spec: EvalCase }> = [];
  for (const name of names) {
    const caseFile = path.join(dir, name);
    const raw = JSON.parse(await readFile(caseFile, 'utf8')) as unknown;
    const spec = EvalCaseSchema.parse(raw);
    if (spec.suite !== 'frozen') throw new Error(`${caseFile} must declare suite=frozen`);
    out.push({ caseFile, spec });
  }
  return out;
}

async function loadLiveCases(): Promise<EvalCase[]> {
  const catalogPath = path.join(evalRoot, 'live', 'cases.json');
  const raw = JSON.parse(await readFile(catalogPath, 'utf8')) as unknown;
  if (Array.isArray(raw)) {
    // Temporary bridge if someone still has a legacy array on disk.
    return raw.map((item) => legacyToLiveCase(item as LegacyLiveCase));
  }
  const catalog = EvalCaseCatalogSchema.parse(raw);
  return catalog.cases;
}

async function loadPrivateCases(): Promise<Array<{ caseFile: string; spec: EvalCase }>> {
  const dir = path.join(evalRoot, 'private');
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: Array<{ caseFile: string; spec: EvalCase }> = [];
  for (const name of names) {
    if (name === 'README.md') continue;
    const caseFile = path.join(dir, name);
    const raw = JSON.parse(await readFile(caseFile, 'utf8')) as unknown;
    const spec = EvalCaseSchema.parse(raw);
    if (spec.suite !== 'private') throw new Error(`${caseFile} must declare suite=private`);
    if (spec.classification === 'frozen') {
      throw new Error(`${caseFile} has classification=frozen; private cases cannot become release blockers without promotion into eval/frozen`);
    }
    out.push({ caseFile, spec });
  }
  return out;
}

function legacyToLiveCase(item: LegacyLiveCase): EvalCase {
  return EvalCaseSchema.parse({
    case_version: 1,
    id: `live-${String(item.id).padStart(3, '0')}`,
    suite: 'live',
    name: item.name,
    function: item.function,
    input: item.input,
    classification: item.time_sensitive ? 'live_only' : 'promote_candidate',
    expect: item.expect,
    time_sensitive: item.time_sensitive === true,
    note: item.note,
    provenance: {
      notes: 'Migrated from legacy eval/cases.json for GW-021 suite split.'
    }
  });
}

async function runFrozen(): Promise<{ rows: EvalRow[]; notes: string[] }> {
  const cases = await loadFrozenCases();
  const rows: EvalRow[] = [];
  const notes: string[] = [
    'Frozen suite runs offline via provider fixture replay.',
    'Release CI must block on frozen failures only.'
  ];
  if (cases.length === 0) {
    notes.push('No frozen cases yet; add adjudicated cases under eval/frozen/cases (GW-024).');
    return { rows, notes };
  }

  const previousToken = process.env.GITHUB_TOKEN;
  if (!previousToken) process.env.GITHUB_TOKEN = 'gitworthy-replay-token';

  try {
    for (const { caseFile, spec } of cases) {
      const fixturesPath = resolveProviderFixturesPath(caseFile, spec.provider_fixtures!);
      await withIsolatedCacheDirs(async () => {
        const install = await installProviderReplay(fixturesPath);
        try {
          const result = await runners[spec.function](spec.input as never) as Record<string, unknown>;
          install.assertExhausted();
          rows.push(evaluateFrozen(result, spec));
        } catch (error) {
          if (error instanceof ProviderReplayError) {
            rows.push({
              id: spec.id,
              name: spec.name,
              status: 'failed',
              detail: `${error.code}: ${error.message}`,
              failure_mode: spec.ground_truth?.failure_mode
            });
          } else {
            const message = error instanceof Error ? error.message : String(error);
            rows.push({
              id: spec.id,
              name: spec.name,
              status: 'failed',
              detail: message,
              failure_mode: spec.ground_truth?.failure_mode
            });
          }
        } finally {
          await install.uninstall();
        }
      });
    }
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }

  return { rows, notes };
}

async function runLive(updateSnapshots: boolean): Promise<{ rows: EvalRow[]; notes: string[] }> {
  if (updateSnapshots) {
    console.warn('warning: --update-snapshots rewrites live result snapshots; never use this in release CI.');
  }
  const cases = await loadLiveCases();
  const snapshotDir = path.join(evalRoot, 'live', 'snapshots');
  await mkdir(snapshotDir, { recursive: true });
  const rows: EvalRow[] = [];
  const notes: string[] = [
    'Live suite observes public-state drift; it never auto-updates provider fixtures.',
    'Live failures are advisory for release gating (frozen suite is release-blocking).'
  ];

  for (const spec of cases) {
    const numericId = spec.id.replace(/^live-0*/, '') || spec.id;
    const snapshotPath = path.join(snapshotDir, `case-${numericId}.json`);
    try {
      const previous = await readFile(snapshotPath, 'utf8')
        .then((content) => JSON.parse(content) as Record<string, unknown>)
        .catch(() => null);
      const result = await runners[spec.function](spec.input as never) as Record<string, unknown>;
      rows.push(evaluateLive(result, spec, previous));
      if (updateSnapshots) await writeFile(snapshotPath, `${fixtureJson(result)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = classifyThrownError(message);
      rows.push({
        id: spec.id,
        name: spec.name,
        status: status === 'failed' ? 'blocked' : status,
        detail: message
      });
    }
  }
  return { rows, notes };
}

async function runPrivate(allowPrivate: boolean): Promise<{ rows: EvalRow[]; notes: string[] }> {
  if (!allowPrivate) {
    throw new Error('Private suite requires --allow-private (local experiments only; not release-blocking).');
  }
  const cases = await loadPrivateCases();
  const rows: EvalRow[] = [];
  const notes: string[] = [
    'Private suite is gitignored and never release-blocking.',
    'Promote into eval/frozen only after human adjudication (GW-018 / GW-024).'
  ];
  if (cases.length === 0) {
    notes.push('No private cases found under eval/private/.');
    return { rows, notes };
  }

  const previousToken = process.env.GITHUB_TOKEN;
  if (!previousToken) process.env.GITHUB_TOKEN = 'gitworthy-replay-token';
  try {
    for (const { caseFile, spec } of cases) {
      if (!spec.provider_fixtures) {
        rows.push({ id: spec.id, name: spec.name, status: 'failed', detail: 'private case missing provider_fixtures' });
        continue;
      }
      const fixturesPath = resolveProviderFixturesPath(caseFile, spec.provider_fixtures);
      await withIsolatedCacheDirs(async () => {
        const install = await installProviderReplay(fixturesPath);
        try {
          const result = await runners[spec.function](spec.input as never) as Record<string, unknown>;
          install.assertExhausted();
          if (spec.ground_truth) rows.push(evaluateFrozen(result, { ...spec, suite: 'frozen', classification: 'frozen' }));
          else rows.push(evaluateLive(result, spec, null));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          rows.push({ id: spec.id, name: spec.name, status: 'failed', detail: message });
        } finally {
          await install.uninstall();
        }
      });
    }
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
  return { rows, notes };
}

function summarize(rows: EvalRow[]) {
  const count = (status: EvalRow['status']) => rows.filter((row) => row.status === status).length;
  return {
    total: rows.length,
    passed: count('passed'),
    failed: count('failed'),
    drifted: count('drifted'),
    blocked: count('blocked'),
    provider_failure: count('provider_failure'),
    auth_limitation: count('auth_limitation'),
    product_regression: count('product_regression')
  };
}

function exitCodeFor(suite: EvalSuite, summary: ReturnType<typeof summarize>): number {
  if (suite === 'frozen') {
    return summary.failed > 0 || summary.product_regression > 0 ? 1 : 0;
  }
  if (suite === 'private') {
    return summary.failed > 0 ? 1 : 0;
  }
  // Live: advisory. Preserve historical floor so a wiped suite still fails loudly.
  const softOk = summary.passed + summary.drifted;
  if (summary.product_regression > 0 || summary.failed > 0) return 1;
  if (summary.blocked > 0 || summary.auth_limitation > 0 || summary.provider_failure > 0) return 1;
  if (summary.total >= 7 && softOk < 7) return 1;
  return 0;
}

async function writeReport(suite: EvalSuite, report: EvalSuiteReport): Promise<void> {
  const reportsDir = path.join(evalRoot, 'reports');
  await mkdir(reportsDir, { recursive: true });
  const file = path.join(reportsDir, `${suite}-${report.generated_at.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  const latest = path.join(reportsDir, `${suite}-latest.json`);
  await writeFile(latest, `${JSON.stringify(report, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`suite: ${args.suite}`);
  console.log(`mode: ${args.suite === 'live' ? (args.updateSnapshots ? 'update-snapshots' : 'compare-only') : 'replay-offline'}`);

  const { rows, notes } = args.suite === 'frozen'
    ? await runFrozen()
    : args.suite === 'private'
      ? await runPrivate(args.allowPrivate)
      : await runLive(args.updateSnapshots);

  const summary = summarize(rows);
  const report = EvalSuiteReportSchema.parse({
    suite: args.suite,
    release_blocking: args.suite === 'frozen',
    generated_at: new Date().toISOString(),
    gitworthy_version: packageVersion(),
    summary,
    rows,
    notes
  });

  console.log('id status  name');
  for (const row of rows) {
    console.log(`${row.id}  ${row.status.padEnd(18)} ${row.name}: ${row.detail}`);
  }
  console.log(
    `summary total=${summary.total} passed=${summary.passed} drifted=${summary.drifted} `
    + `product_regression=${summary.product_regression} blocked=${summary.blocked} `
    + `provider_failure=${summary.provider_failure} auth_limitation=${summary.auth_limitation} failed=${summary.failed}`
  );
  for (const note of notes) console.log(`note: ${note}`);

  await writeReport(args.suite, report);
  console.log(`report: eval/reports/${args.suite}-latest.json`);

  process.exitCode = exitCodeFor(args.suite, summary);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
