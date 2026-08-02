import { createEnvelope, Envelope, GitworthyError } from './envelope.js';
import { getCaptureManifest, listCaptureManifests, promoteCapture } from '../lib/capture-store.js';
import { CasePromoteInputSchema } from '../contracts/inputs.js';

export async function capture_show(input: { capture_id: string }): Promise<Envelope> {
  const manifest = await getCaptureManifest(input.capture_id);
  if (!manifest) {
    throw new GitworthyError({
      code: 'capture_not_found',
      message: `Capture ${input.capture_id} was not found in the local store.`,
      not_checked: [`capture ${input.capture_id}`]
    });
  }
  return createEnvelope({
    verdict_summary: `capture ${manifest.capture_id}: ${manifest.exchanges.length} exchange(s), mode=${manifest.capture_mode}.`,
    evidence: [manifest],
    checked: [`loaded capture ${manifest.capture_id}`],
    not_checked: ['capture show does not re-run provider requests'],
    cached: true
  });
}

export async function capture_list(input: { limit?: number } = {}): Promise<Envelope> {
  const rows = await listCaptureManifests(input);
  return createEnvelope({
    verdict_summary: `listed ${rows.length} capture${rows.length === 1 ? '' : 's'}.`,
    evidence: rows,
    checked: ['listed durable capture manifests'],
    not_checked: ['capture list skips malformed captures after quarantine'],
    cached: true
  });
}

export async function case_promote(input: {
  capture_id: string;
  verdict: string;
  disposition: string;
  adjudicator_rationale: string;
  evidence_urls: string[];
  out_path: string;
  force?: boolean;
}): Promise<Envelope> {
  const validation = CasePromoteInputSchema.safeParse(input);
  if (!validation.success) {
    const issue = validation.error.issues[0];
    throw new GitworthyError({
      code: issue?.path?.[0] === 'adjudicator_rationale' ? 'case_promote_requires_rationale' : 'invalid_usage',
      message: issue?.message ?? 'invalid case promotion input',
      not_checked: ['promotion fixture was not written']
    });
  }
  const parsed = validation.data;
  const result = await promoteCapture(parsed);
  return createEnvelope({
    verdict_summary: `wrote proposed case fixture for capture ${parsed.capture_id} to ${result.out_path}.`,
    evidence: [{ out_path: result.out_path, fixture: result.fixture }],
    checked: [
      `loaded capture ${parsed.capture_id}`,
      'validated human adjudication fields',
      `wrote proposed fixture ${result.out_path}`
    ],
    not_checked: ['case promote does not commit, publish, or update frozen fixtures automatically'],
    cached: false
  });
}
