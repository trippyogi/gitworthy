import { constants } from 'node:fs';
import { access, mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CASE_FIXTURE_VERSION,
  CasePromotionFixtureSchema,
  CaptureManifestSchema,
  type CaptureManifest,
  type CasePromotionFixture
} from '../contracts/capture.js';
import { DispositionSchema, VerdictSchema } from '../contracts/common.js';
import { GitworthyError } from '../core/envelope.js';
import { readJsonFile, storeRoot, withStoreLock, writeJsonAtomic } from './store-fs.js';

function capturesDir(): string {
  return path.join(storeRoot(), 'captures');
}

function quarantineDir(): string {
  return path.join(capturesDir(), 'quarantine');
}

export function captureBundleDir(captureId: string): string {
  return path.join(capturesDir(), safeCaptureId(captureId));
}

export function captureManifestPath(captureId: string): string {
  return path.join(captureBundleDir(captureId), 'manifest.json');
}

export async function putCaptureManifest(manifest: CaptureManifest): Promise<CaptureManifest> {
  const parsed = CaptureManifestSchema.parse(manifest);
  return withStoreLock(`capture:${parsed.capture_id}`, async () => {
    await writeJsonAtomic(captureManifestPath(parsed.capture_id), parsed);
    return parsed;
  });
}

export async function getCaptureManifest(captureId: string): Promise<CaptureManifest | null> {
  const file = captureManifestPath(captureId);
  const raw = await readJsonFile<unknown>(file);
  if (!raw) return null;
  const parsed = CaptureManifestSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  await quarantineCapture(captureId);
  throw new GitworthyError({
    code: 'capture_malformed',
    message: `Capture ${captureId} is malformed and was moved to quarantine.`,
    not_checked: [`capture ${captureId} could not be parsed as a GW-018 capture manifest`]
  });
}

export async function listCaptureManifests(input: { limit?: number } = {}): Promise<CaptureManifest[]> {
  let names: string[];
  try {
    names = await readdir(capturesDir());
  } catch {
    return [];
  }
  const rows: CaptureManifest[] = [];
  for (const name of names) {
    if (name === 'quarantine') continue;
    try {
      const manifest = await getCaptureManifest(name);
      if (manifest) rows.push(manifest);
    } catch {
      // Malformed captures are quarantined by getCaptureManifest and skipped from list output.
    }
  }
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return typeof input.limit === 'number' ? rows.slice(0, Math.max(0, input.limit)) : rows;
}

export async function promoteCapture(input: {
  capture_id: string;
  verdict: import('zod').infer<typeof VerdictSchema>;
  disposition: import('zod').infer<typeof DispositionSchema>;
  adjudicator_rationale: string;
  evidence_urls: string[];
  out_path: string;
  force?: boolean;
}): Promise<{ out_path: string; fixture: CasePromotionFixture }> {
  if (input.adjudicator_rationale.trim().length === 0) {
    throw new GitworthyError({
      code: 'case_promote_requires_rationale',
      message: 'case promote requires a non-empty adjudicator rationale.',
      not_checked: ['promotion fixture was not written']
    });
  }
  const manifest = await getCaptureManifest(input.capture_id);
  if (!manifest) {
    throw new GitworthyError({
      code: 'capture_not_found',
      message: `Capture ${input.capture_id} was not found in the local store.`,
      not_checked: [`capture ${input.capture_id}`]
    });
  }
  if (!manifest.promotable || manifest.capture_mode !== 'public') {
    throw new GitworthyError({
      code: 'capture_not_promotable',
      message: `Capture ${input.capture_id} is local-only/private and cannot be promoted.`,
      not_checked: ['promotion fixture was not written']
    });
  }
  if (!input.force && await exists(input.out_path)) {
    throw new GitworthyError({
      code: 'case_promote_output_exists',
      message: `Refusing to overwrite existing fixture ${input.out_path}; pass --force to replace it.`,
      not_checked: ['promotion fixture was not written']
    });
  }
  const fixture = CasePromotionFixtureSchema.parse({
    fixture_version: CASE_FIXTURE_VERSION,
    source: {
      capture_id: manifest.capture_id,
      capture_created_at: manifest.created_at,
      gitworthy_version: manifest.gitworthy_version,
      command: manifest.command,
      run_id: manifest.run_id,
      decision_id: manifest.decision_id,
      decision_ids: manifest.decision_ids,
      target: manifest.target
    },
    ground_truth: {
      verdict: input.verdict,
      disposition: input.disposition,
      adjudicator_rationale: input.adjudicator_rationale.trim(),
      evidence_urls: input.evidence_urls
    },
    replay: {
      exchanges: manifest.exchanges.map((exchange) => ({
        sequence: exchange.sequence,
        provider: exchange.provider,
        method: exchange.method,
        canonical_url: exchange.canonical_url,
        status: exchange.status,
        response_headers: exchange.response_headers,
        body_digest_sha256: exchange.body_digest_sha256,
        body_omitted_reason: exchange.body_omitted_reason,
        response_fields: exchange.response_fields
      }))
    }
  });
  await writeJsonAtomic(input.out_path, fixture);
  return { out_path: input.out_path, fixture };
}

async function quarantineCapture(captureId: string): Promise<void> {
  const from = captureBundleDir(captureId);
  const suffix = new Date().toISOString().replace(/[^0-9TZ]/g, '');
  const to = path.join(quarantineDir(), `${safeCaptureId(captureId)}-${suffix}`);
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to).catch(() => undefined);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  }
}

function safeCaptureId(captureId: string): string {
  return captureId.replace(/[^a-zA-Z0-9._-]+/g, '_');
}
