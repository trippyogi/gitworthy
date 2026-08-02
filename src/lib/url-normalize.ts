import { createHash } from 'node:crypto';
import { digestUtf8 } from '../contracts/provider-fixtures.js';
import { redactUrl } from './redaction.js';

/** Canonicalize an HTTP URL for deterministic fixture matching (GW-022). */
export function normalizeRequestUrl(input: string | URL): string {
  const url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
  url.hash = '';
  url.username = '';
  url.password = '';
  // Sort query params; drop empty values that GitHub sometimes omits inconsistently.
  const params = [...url.searchParams.entries()]
    .filter(([, value]) => value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);
  // Prefer redacted form so tokens never participate in matching keys.
  return redactUrl(url.toString());
}

export function normalizeHttpMethod(method: string | undefined): string {
  return (method ?? 'GET').toUpperCase();
}

export async function normalizeRequestBodyDigest(body: RequestInit['body'] | undefined): Promise<string | null> {
  if (body == null || body === '') return null;
  if (typeof body === 'string') return digestUtf8(body);
  if (body instanceof Uint8Array) return createHash('sha256').update(body).digest('hex');
  if (body instanceof ArrayBuffer) return createHash('sha256').update(new Uint8Array(body)).digest('hex');
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const bytes = new Uint8Array(await body.arrayBuffer());
    return createHash('sha256').update(bytes).digest('hex');
  }
  // FormData / streams are uncommon in gitworthy providers; hash a stable label.
  return digestUtf8(`[unsupported-body:${Object.prototype.toString.call(body)}]`);
}

export function httpMatchKey(input: {
  method: string;
  canonical_url: string;
  request_body_digest_sha256?: string | null;
}): string {
  return [
    normalizeHttpMethod(input.method),
    normalizeRequestUrl(input.canonical_url),
    input.request_body_digest_sha256 ?? ''
  ].join('\n');
}
