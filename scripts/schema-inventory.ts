/** Inventory public schemas for GW-035 freeze prep. */

import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const schemasDir = path.join(process.cwd(), 'schemas');
const names = readdirSync(schemasDir).filter((name) => name.endsWith('.schema.json')).sort();

const inventory = {
  generated_at: new Date().toISOString(),
  schema_count: names.length,
  schemas: names,
  note: 'Pre-1.0 draft. SCHEMA_VERSION remains 1.0-draft.1 until GW-035 freeze after beta.'
};

const out = path.join(process.cwd(), 'docs', 'SCHEMA_INVENTORY.json');
writeFileSync(out, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
console.log(`wrote ${out} (${names.length} schemas)`);
