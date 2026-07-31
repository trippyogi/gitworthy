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
import { RunRecordSchema, DecisionRecordSchema, TargetIndexSchema } from '../src/contracts/store.js';

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
  { file: 'gitworthy-run-record.v1.schema.json', schema: RunRecordSchema },
  { file: 'gitworthy-decision-record.v1.schema.json', schema: DecisionRecordSchema },
  { file: 'gitworthy-target-index.v1.schema.json', schema: TargetIndexSchema }
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
