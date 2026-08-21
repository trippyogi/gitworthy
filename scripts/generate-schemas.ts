import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CommonResultCoreSchema } from '../src/contracts/common.js';
import { ErrorResultSchema } from '../src/contracts/errors.js';
import { FindingSchema } from '../src/contracts/findings.js';
import { CheckResultSchema } from '../src/contracts/check.js';
import { ScanResultSchema } from '../src/contracts/scan.js';
import { HuntResultSchema } from '../src/contracts/hunt.js';
import { DoctorResultSchema } from '../src/contracts/doctor.js';
import { LedgerResultSchema } from '../src/contracts/ledger.js';
import { OutcomeEventSchema } from '../src/contracts/outcomes.js';
import { BriefSchema } from '../src/contracts/brief.js';
import { RunRecordSchema, DecisionRecordSchema, TargetIndexSchema } from '../src/contracts/store.js';
import { CaptureManifestSchema, CasePromotionFixtureSchema } from '../src/contracts/capture.js';
import { ConfigFileSchema, TargetManifestSchema, SkillProfileV1Schema } from '../src/contracts/config.js';
import { EvalCaseSchema, EvalCaseCatalogSchema, EvalQualityReportSchema, EvalSuiteReportSchema } from '../src/contracts/eval.js';
import { ProviderFixturePackSchema } from '../src/contracts/provider-fixtures.js';
import { ContentionReportSchema } from '../src/contracts/contention.js';
import { RoutingDecisionSchema } from '../src/contracts/routing.js';
import { PortfolioItemSchema } from '../src/contracts/portfolio.js';
import { PrScanResultSchema } from '../src/contracts/pr-scan.js';
import { OpportunityTargetSchema } from '../src/contracts/opportunities.js';
import { ContributionProfileSchema } from '../src/contracts/contribution-profile.js';
import { RoutingEvalMetricsSchema } from '../src/contracts/routing-eval.js';
import {
  TrackOCovariatesRecordSchema,
  TrackOContingencyTableSchema,
  TrackOJoinKeySchema
} from '../src/contracts/track-o.js';

const outDir = join(process.cwd(), 'schemas');
mkdirSync(outDir, { recursive: true });

const docs: Array<{ file: string; schema: z.ZodType }> = [
  { file: 'gitworthy-common.v1.schema.json', schema: CommonResultCoreSchema },
  { file: 'gitworthy-error.v1.schema.json', schema: ErrorResultSchema },
  { file: 'gitworthy-finding.v1.schema.json', schema: FindingSchema },
  { file: 'gitworthy-check.v1.schema.json', schema: CheckResultSchema },
  { file: 'gitworthy-scan.v1.schema.json', schema: ScanResultSchema },
  { file: 'gitworthy-hunt.v1.schema.json', schema: HuntResultSchema },
  { file: 'gitworthy-doctor.v1.schema.json', schema: DoctorResultSchema },
  { file: 'gitworthy-ledger.v1.schema.json', schema: LedgerResultSchema },
  { file: 'gitworthy-outcome-event.v1.schema.json', schema: OutcomeEventSchema },
  { file: 'gitworthy-brief.v1.schema.json', schema: BriefSchema },
  { file: 'gitworthy-run-record.v1.schema.json', schema: RunRecordSchema },
  { file: 'gitworthy-decision-record.v1.schema.json', schema: DecisionRecordSchema },
  { file: 'gitworthy-target-index.v1.schema.json', schema: TargetIndexSchema },
  { file: 'gitworthy-capture-manifest.v1.schema.json', schema: CaptureManifestSchema },
  { file: 'gitworthy-case-promotion-fixture.v1.schema.json', schema: CasePromotionFixtureSchema },
  { file: 'gitworthy-config.v1.schema.json', schema: ConfigFileSchema },
  { file: 'gitworthy-target-manifest.v1.schema.json', schema: TargetManifestSchema },
  { file: 'gitworthy-skill-profile.v1.schema.json', schema: SkillProfileV1Schema },
  { file: 'gitworthy-eval-case.v1.schema.json', schema: EvalCaseSchema },
  { file: 'gitworthy-eval-case-catalog.v1.schema.json', schema: EvalCaseCatalogSchema },
  { file: 'gitworthy-eval-suite-report.v1.schema.json', schema: EvalSuiteReportSchema },
  { file: 'gitworthy-eval-quality-report.v1.schema.json', schema: EvalQualityReportSchema },
  { file: 'gitworthy-provider-fixture-pack.v1.schema.json', schema: ProviderFixturePackSchema },
  { file: 'gitworthy-contention-report.v1.schema.json', schema: ContentionReportSchema },
  { file: 'gitworthy-routing-decision.v1.schema.json', schema: RoutingDecisionSchema },
  { file: 'gitworthy-opportunity-target.v1.schema.json', schema: OpportunityTargetSchema },
  { file: 'gitworthy-pr-scan.v1.schema.json', schema: PrScanResultSchema },
  { file: 'gitworthy-portfolio-item.v1.schema.json', schema: PortfolioItemSchema },
  { file: 'gitworthy-contribution-profile.v1.schema.json', schema: ContributionProfileSchema },
  { file: 'gitworthy-routing-eval-metrics.v1.schema.json', schema: RoutingEvalMetricsSchema },
  { file: 'gitworthy-track-o-join-key.v1.schema.json', schema: TrackOJoinKeySchema },
  { file: 'gitworthy-track-o-covariates.v1.schema.json', schema: TrackOCovariatesRecordSchema },
  { file: 'gitworthy-track-o-contingency.v1.schema.json', schema: TrackOContingencyTableSchema }
];

const checkOnly = process.argv.includes('--check');
let drift = false;

for (const doc of docs) {
  const json = `${JSON.stringify(z.toJSONSchema(doc.schema), null, 2)}\n`;
  const path = join(outDir, doc.file);
  if (checkOnly) {
    try {
      const existing = readFileSync(path, 'utf8');
      if (existing !== json) {
        console.error(`schema drift: ${doc.file}`);
        drift = true;
      }
    } catch {
      console.error(`schema missing: ${doc.file}`);
      drift = true;
    }
  } else {
    writeFileSync(path, json);
    console.log(`wrote ${doc.file}`);
  }
}

if (checkOnly) {
  const expected = new Set(docs.map((doc) => doc.file));
  for (const name of readdirSync(outDir)) {
    if (name.endsWith('.schema.json') && !expected.has(name)) {
      console.error(`unexpected schema file: ${name}`);
      drift = true;
    }
  }
  if (drift) {
    console.error('Run `pnpm schemas:generate` and commit the result.');
    process.exit(1);
  }
  console.log('schemas up to date');
}
