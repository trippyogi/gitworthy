import { z } from 'zod';
import { DispositionSchema, SCHEMA_VERSION, SchemaVersionSchema, VerdictSchema } from './common.js';

export const CAPTURE_RECORD_VERSION = 1 as const;
export const CASE_FIXTURE_VERSION = 1 as const;

export const CaptureModeSchema = z.enum(['public', 'local_only']);

export const CaptureTargetSchema = z.object({
  kind: z.enum(['repo_issue', 'repo', 'org']),
  input: z.string().min(1),
  canonical: z.string().optional(),
  issue_number: z.number().int().positive().optional(),
  html_url: z.string().url().optional(),
  is_private: z.boolean().nullable()
});

export const CaptureSourceSchema = z.object({
  surface: z.enum(['cli', 'mcp', 'test', 'unknown']),
  requested_at: z.string().datetime(),
  attribution: z.string().min(1)
});

export const CapturedExchangeSchema = z.object({
  sequence: z.number().int().nonnegative(),
  captured_at: z.string().datetime(),
  provider: z.enum(['github', 'github_raw', 'npm', 'unknown']),
  method: z.string().min(1),
  canonical_url: z.string().min(1),
  status: z.number().int().nonnegative(),
  request_headers: z.record(z.string(), z.string()).default({}),
  response_headers: z.record(z.string(), z.string()).default({}),
  request_body_digest_sha256: z.string().nullable().default(null),
  body_digest_sha256: z.string().nullable().default(null),
  body_omitted_reason: z.string().optional(),
  response_fields: z.unknown().optional()
});

export const CaptureManifestSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  record_version: z.literal(CAPTURE_RECORD_VERSION),
  record_kind: z.literal('capture'),
  capture_id: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  gitworthy_version: z.string().min(1),
  run_id: z.string().optional(),
  decision_id: z.string().optional(),
  decision_ids: z.array(z.string()).default([]),
  command: z.enum(['check', 'hunt']),
  target: CaptureTargetSchema,
  source: CaptureSourceSchema,
  capture_mode: CaptureModeSchema,
  promotable: z.boolean(),
  exchanges: z.array(CapturedExchangeSchema).default([]),
  errors: z.array(z.string()).default([])
}).refine((manifest) => manifest.promotable === (manifest.capture_mode === 'public' && manifest.target.is_private === false), {
  path: ['promotable'],
  message: 'promotable must be true only for public captures with target.is_private=false'
});

export const CasePromotionFixtureSchema = z.object({
  fixture_version: z.literal(CASE_FIXTURE_VERSION),
  source: z.object({
    capture_id: z.string().min(1),
    capture_created_at: z.string().datetime(),
    gitworthy_version: z.string().min(1),
    command: z.enum(['check', 'hunt']),
    run_id: z.string().optional(),
    decision_id: z.string().optional(),
    decision_ids: z.array(z.string()).default([]),
    target: CaptureTargetSchema
  }),
  ground_truth: z.object({
    verdict: VerdictSchema,
    disposition: DispositionSchema,
    adjudicator_rationale: z.string().min(1),
    evidence_urls: z.array(z.string().url()).min(1)
  }),
  replay: z.object({
    exchanges: z.array(CapturedExchangeSchema.pick({
      sequence: true,
      provider: true,
      method: true,
      canonical_url: true,
      status: true,
      response_headers: true,
      body_digest_sha256: true,
      body_omitted_reason: true,
      response_fields: true
    }))
  })
});

export type CaptureManifest = z.infer<typeof CaptureManifestSchema>;
export type CapturedExchange = z.infer<typeof CapturedExchangeSchema>;
export type CaptureMode = z.infer<typeof CaptureModeSchema>;
export type CaptureTarget = z.infer<typeof CaptureTargetSchema>;
export type CasePromotionFixture = z.infer<typeof CasePromotionFixtureSchema>;
