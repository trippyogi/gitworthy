import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SCHEMA_VERSION, SchemaVersionSchema } from './common.js';

/** Versioned provider fixture pack for offline replay (GW-022). */
export const PROVIDER_FIXTURE_VERSION = 1 as const;

/** Headers that must never appear as request or response fixture material. */
export const FORBIDDEN_FIXTURE_HEADER_NAMES = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-access-token',
  'x-github-token'
] as const;

const ForbiddenHeaderNameSet = new Set<string>(FORBIDDEN_FIXTURE_HEADER_NAMES);

export const ProviderKindSchema = z.enum(['github', 'github_raw', 'npm', 'git', 'unknown']);
export const HttpProviderKindSchema = z.enum(['github', 'github_raw', 'npm', 'unknown']);

export const HttpBodyEncodingSchema = z.enum(['json', 'text', 'base64', 'omitted']);

export const HttpReplayErrorSchema = z.enum(['timeout', 'network', 'abort']);

export const NormalizedHttpMatchSchema = z.object({
  method: z.string().min(1),
  canonical_url: z.string().min(1),
  /** SHA-256 of normalized request body bytes when present; null for empty/absent bodies. */
  request_body_digest_sha256: z.string().nullable().default(null)
}).strict();

export const HttpFixtureExchangeSchema = z.object({
  sequence: z.number().int().nonnegative(),
  provider: HttpProviderKindSchema,
  match: NormalizedHttpMatchSchema,
  response: z.object({
    status: z.number().int().nonnegative().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    body_encoding: HttpBodyEncodingSchema.default('json'),
    body: z.unknown().optional(),
    body_omitted_reason: z.string().optional(),
    error: HttpReplayErrorSchema.optional()
  }).strict().superRefine((response, ctx) => {
    if (response.error) return;
    if (response.status === undefined) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'status is required when error is not set' });
    }
    if (response.body_encoding === 'omitted' && response.body !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'omitted bodies must not include body' });
    }
  })
}).strict().superRefine((exchange, ctx) => {
  for (const [name, value] of Object.entries(exchange.response.headers)) {
    if (ForbiddenHeaderNameSet.has(name.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        path: ['response', 'headers', name],
        message: `secret-bearing header ${name} is structurally disallowed in fixtures`
      });
    }
    if (/bearer\s+\S+/i.test(value) || /token\s+[a-z0-9_-]{8,}/i.test(value)) {
      ctx.addIssue({
        code: 'custom',
        path: ['response', 'headers', name],
        message: `header ${name} appears to contain a credential`
      });
    }
  }
});

export const GitProbeKindSchema = z.enum([
  'ls_remote_heads',
  'shallow_clone',
  'list_tree',
  'read_tree_file'
]);

export const GitTreeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  symlink: z.boolean().default(false)
}).strict();

export const GitFixtureProbeSchema = z.object({
  sequence: z.number().int().nonnegative(),
  kind: GitProbeKindSchema,
  match: z.object({
    repo: z.string().min(1),
    ref: z.string().min(1).optional(),
    path: z.string().min(1).optional()
  }).strict(),
  response: z.object({
    heads: z.array(z.object({
      name: z.string().min(1),
      sha: z.string().min(1)
    }).strict()).optional(),
    files: z.array(GitTreeFileSchema).optional(),
    truncated: z.boolean().optional(),
    content: z.string().nullable().optional(),
    error: z.enum(['ls_remote_failed', 'clone_failed', 'ls_tree_failed', 'read_failed']).optional()
  }).strict()
}).strict();

export const ProviderFixtureAttributionSchema = z.object({
  capture_id: z.string().min(1).optional(),
  capture_created_at: z.string().datetime().optional(),
  gitworthy_version: z.string().min(1).optional(),
  notes: z.string().optional()
}).strict();

export const ProviderFixturePackSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  fixture_version: z.literal(PROVIDER_FIXTURE_VERSION),
  case_id: z.string().min(1),
  attributed_from: ProviderFixtureAttributionSchema.optional(),
  http_exchanges: z.array(HttpFixtureExchangeSchema).default([]),
  git_probes: z.array(GitFixtureProbeSchema).default([])
}).strict().superRefine((pack, ctx) => {
  if (pack.http_exchanges.length === 0 && pack.git_probes.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'provider fixture pack must include at least one http or git probe' });
  }
  const httpSequences = new Set<number>();
  for (const [index, exchange] of pack.http_exchanges.entries()) {
    if (httpSequences.has(exchange.sequence)) {
      ctx.addIssue({
        code: 'custom',
        path: ['http_exchanges', index, 'sequence'],
        message: `duplicate http sequence ${exchange.sequence}`
      });
    }
    httpSequences.add(exchange.sequence);
  }
});

export type ProviderFixturePack = z.infer<typeof ProviderFixturePackSchema>;
export type HttpFixtureExchange = z.infer<typeof HttpFixtureExchangeSchema>;
export type GitFixtureProbe = z.infer<typeof GitFixtureProbeSchema>;
export type NormalizedHttpMatch = z.infer<typeof NormalizedHttpMatchSchema>;

export function digestUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
