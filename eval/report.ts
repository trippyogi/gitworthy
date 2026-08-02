/**
 * Frozen eval quality report (GW-023).
 *
 * Usage:
 *   pnpm eval:report
 *   pnpm eval:report -- --milestone=0.6.0
 *   pnpm eval:report -- --suite-report=eval/reports/frozen-latest.json
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EvalCaseSchema,
  EvalMilestoneSchema,
  type EvalCase,
  type EvalMilestone
} from '../src/contracts/eval.js';
import { exitCodeForQualityReport, generateEvalQualityReport } from './lib/report-gen.js';
import { evalRoot } from './lib/shared.js';

function parseArgs(argv: string[]): {
  milestone: EvalMilestone;
  suiteReportPath: string;
  outputDir: string;
} {
  const milestoneArg = argv.find((arg) => arg.startsWith('--milestone='))?.slice('--milestone='.length)
    ?? argv[argv.indexOf('--milestone') + 1]
    ?? '0.6.0';
  const milestone = EvalMilestoneSchema.parse(milestoneArg);
  const suiteReportPath = argv.find((arg) => arg.startsWith('--suite-report='))?.slice('--suite-report='.length)
    ?? argv[argv.indexOf('--suite-report') + 1]
    ?? path.join(evalRoot, 'reports', 'frozen-latest.json');
  const outputDir = argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length)
    ?? argv[argv.indexOf('--output') + 1]
    ?? path.join(evalRoot, 'reports');
  return {
    milestone,
    suiteReportPath: path.resolve(suiteReportPath),
    outputDir: path.resolve(outputDir)
  };
}

async function loadFrozenCases(): Promise<Array<{ caseFile: string; spec: EvalCase }>> {
  const dir = path.join(evalRoot, 'frozen', 'cases');
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  const out: Array<{ caseFile: string; spec: EvalCase }> = [];
  for (const name of names) {
    const caseFile = path.join(dir, name);
    const raw = JSON.parse(await readFile(caseFile, 'utf8')) as unknown;
    out.push({ caseFile, spec: EvalCaseSchema.parse(raw) });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = await loadFrozenCases();
  const suiteReportRaw = JSON.parse(await readFile(args.suiteReportPath, 'utf8')) as unknown;
  const report = generateEvalQualityReport({
    cases,
    suiteReport: suiteReportRaw,
    milestone: args.milestone,
    suiteReportPath: path.relative(process.cwd(), args.suiteReportPath).replace(/\\/g, '/'),
    caseCatalogPath: 'eval/frozen/cases'
  });

  await mkdir(args.outputDir, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, '-');
  const jsonPath = path.join(args.outputDir, `quality-${stamp}.json`);
  const latestJsonPath = path.join(args.outputDir, 'quality-latest.json');
  const summaryPath = path.join(args.outputDir, 'quality-latest.summary.txt');
  const ciSummaryPath = path.join(args.outputDir, 'quality-ci-summary.txt');

  const jsonBody = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(jsonPath, jsonBody);
  await writeFile(latestJsonPath, jsonBody);
  await writeFile(summaryPath, `${report.summary_text}\n`);
  await writeFile(ciSummaryPath, `${report.summary_text}\n`);

  console.log(report.summary_text);
  console.log(`json: ${path.relative(process.cwd(), latestJsonPath).replace(/\\/g, '/')}`);
  console.log(`summary: ${path.relative(process.cwd(), summaryPath).replace(/\\/g, '/')}`);

  process.exitCode = exitCodeForQualityReport(report);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
