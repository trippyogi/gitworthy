const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-request-id|x-github-request-id|traceparent|tracestate)$/i;
const SENSITIVE_PARAM = /^(access_token|token|auth|authorization|client_secret|password|request_id|request-id|x-request-id)$/i;
const SENSITIVE_KEY = /(token|authorization|cookie|secret|password|request[_-]?id|x-github-request-id)/i;

export function redactHeaders(headers: RequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const normalized = headers instanceof Headers ? headers : new Headers(headers);
  normalized.forEach((value, key) => {
    out[key] = SENSITIVE_HEADER.test(key) || looksTokenLike(value) ? '[redacted]' : value;
  });
  return out;
}

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '[redacted]';
    if (parsed.password) parsed.password = '[redacted]';
    const next = new URLSearchParams();
    const entries = [...parsed.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
    for (const [key, value] of entries) {
      next.append(key, SENSITIVE_PARAM.test(key) || looksTokenLike(value) ? '[redacted]' : value);
    }
    parsed.search = next.toString();
    return parsed.toString();
  } catch {
    return scrubSecretText(url);
  }
}

export function scrubSecretText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,&"']+/gi, '$1[redacted]')
    .replace(/(cookie\s*[:=]\s*)[^\n\r;,"']+/gi, '$1[redacted]')
    .replace(/((?:access_token|token|client_secret|password|request[_-]?id)\s*[:=]\s*)[^\s,&"']+/gi, '$1[redacted]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, 'Bearer [redacted]');
}

export function scrubJsonSecrets(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecretText(value);
  if (Array.isArray(value)) return value.map((item) => scrubJsonSecrets(item));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrubJsonSecrets(child);
  }
  return out;
}

function looksTokenLike(value: string): boolean {
  return /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /^bearer\s+[A-Za-z0-9._~+/=-]{16,}$/i.test(value);
}
