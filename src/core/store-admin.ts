import { createEnvelope, Envelope } from './envelope.js';
import { migrateLegacyLedger, type LedgerMigrationReport } from '../lib/store-migrate.js';
import { rebuildTargetIndexes } from '../lib/store.js';

export async function store_migrate_ledger(input: { force?: boolean } = {}): Promise<Envelope> {
  const report: LedgerMigrationReport = await migrateLegacyLedger({ force: input.force === true });
  return createEnvelope({
    verdict_summary: report.already_done
      ? `legacy ledger migration ${report.migration_id} already completed (${report.migrated} migrated, ${report.quarantined} quarantined).`
      : `migrated ${report.migrated} legacy ledger entr${report.migrated === 1 ? 'y' : 'ies'}; quarantined ${report.quarantined}; rebuilt ${report.rebuilt_targets} target indexes.`,
    evidence: [report],
    signals: [],
    checked: [
      `read legacy ledger at ${report.ledger_path}`,
      report.already_done ? 'skipped migrate (marker present)' : 'wrote migrated run/decision records',
      `quarantine directory ${report.quarantine_dir}`,
      `migration marker ${report.marker_path}`
    ],
    not_checked: [
      'legacy ledger entries are scout memory snapshots; migration does not re-run worth_check.',
      'original ledger file is retained after migration so hunt/ledger CLI keep working.'
    ],
    cached: false
  });
}

export async function store_rebuild_indexes(): Promise<Envelope> {
  const report = await rebuildTargetIndexes();
  return createEnvelope({
    verdict_summary: `rebuilt ${report.targets} target index${report.targets === 1 ? '' : 'es'} from ${report.runs} runs, ${report.decisions} decisions, ${report.outcomes} outcomes (${report.skipped} skipped).`,
    evidence: [report],
    signals: [],
    checked: ['scanned durable store records', 'rewrote per-target indexes'],
    not_checked: ['corrupt store records that fail schema validation are skipped during rebuild'],
    cached: false
  });
}
