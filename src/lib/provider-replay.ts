/** Offline HTTP replay transport over versioned provider fixtures (GW-022). */

import {
  type CasePromotionFixture,
  type CapturedExchange
} from '../contracts/capture.js';
import {
  type HttpFixtureExchange,
  type ProviderFixturePack,
  ProviderFixturePackSchema,
  digestUtf8
} from '../contracts/provider-fixtures.js';
import { HttpClientError, type HttpTransport } from './http-client.js';
import { httpMatchKey, normalizeHttpMethod, normalizeRequestBodyDigest, normalizeRequestUrl } from './url-normalize.js';

export class ProviderReplayError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProviderReplayError';
    this.code = code;
    this.details = details;
  }
}

type QueuedExchange = {
  exchange: HttpFixtureExchange;
  consumed: boolean;
};

export type HttpReplaySession = {
  transport: HttpTransport;
  assertExhausted: () => void;
  unused: () => HttpFixtureExchange[];
};

export function createHttpReplaySession(pack: ProviderFixturePack): HttpReplaySession {
  const parsed = ProviderFixturePackSchema.parse(pack);
  const queues = new Map<string, QueuedExchange[]>();

  for (const exchange of [...parsed.http_exchanges].sort((a, b) => a.sequence - b.sequence)) {
    const key = httpMatchKey(exchange.match);
    const list = queues.get(key) ?? [];
    list.push({ exchange, consumed: false });
    queues.set(key, list);
  }

  const transport: HttpTransport = async (input, init) => {
    const method = normalizeHttpMethod(init?.method);
    const canonical_url = normalizeRequestUrl(input);
    const request_body_digest_sha256 = await normalizeRequestBodyDigest(init?.body);
    const key = httpMatchKey({ method, canonical_url, request_body_digest_sha256 });
    const queue = queues.get(key);
    const next = queue?.find((item) => !item.consumed);
    if (!next) {
      const available = [...queues.entries()]
        .flatMap(([matchKey, items]) => items.filter((item) => !item.consumed).map((item) => ({
          match_key: matchKey,
          sequence: item.exchange.sequence,
          method: item.exchange.match.method,
          canonical_url: item.exchange.match.canonical_url
        })));
      throw new ProviderReplayError(
        'replay_unexpected_request',
        `Unexpected HTTP request during replay: ${method} ${canonical_url}`,
        {
          method,
          canonical_url,
          request_body_digest_sha256,
          unused_fixtures: available
        }
      );
    }
    next.consumed = true;
    return materializeResponse(next.exchange);
  };

  return {
    transport,
    unused: () => [...queues.values()].flatMap((items) => items.filter((item) => !item.consumed).map((item) => item.exchange)),
    assertExhausted: () => {
      const leftover = [...queues.values()].flatMap((items) => items.filter((item) => !item.consumed));
      if (leftover.length === 0) return;
      throw new ProviderReplayError(
        'replay_unused_fixtures',
        `Replay left ${leftover.length} unused HTTP fixture(s).`,
        {
          unused: leftover.map((item) => ({
            sequence: item.exchange.sequence,
            method: item.exchange.match.method,
            canonical_url: item.exchange.match.canonical_url
          }))
        }
      );
    }
  };
}

function materializeResponse(exchange: HttpFixtureExchange): Response {
  const response = exchange.response;
  if (response.error === 'timeout') {
    const error = new HttpClientError({
      code: 'http_timeout',
      message: `Replay fixture sequence ${exchange.sequence} simulated a timeout for ${exchange.match.canonical_url}.`
    });
    throw error;
  }
  if (response.error === 'network' || response.error === 'abort') {
    const error = new Error(`Replay fixture sequence ${exchange.sequence} simulated a ${response.error} failure.`);
    error.name = response.error === 'abort' ? 'AbortError' : 'TypeError';
    throw error;
  }

  const headers = new Headers(response.headers);
  let body: string | Uint8Array | null = null;
  switch (response.body_encoding) {
    case 'json':
      body = JSON.stringify(response.body ?? null);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      break;
    case 'text':
      body = typeof response.body === 'string' ? response.body : String(response.body ?? '');
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
      break;
    case 'base64': {
      const text = typeof response.body === 'string' ? response.body : '';
      body = Buffer.from(text, 'base64');
      break;
    }
    case 'omitted':
      body = null;
      break;
    default:
      body = null;
  }

  return new Response(body, {
    status: response.status ?? 500,
    headers
  });
}

/**
 * Deterministic capture / promotion fixture → provider pack conversion.
 * Uses truncated `response_fields` when present; marks omitted bodies explicitly.
 */
export function captureExchangesToProviderPack(input: {
  case_id: string;
  exchanges: Array<{
    sequence: number;
    provider: CapturedExchange['provider'];
    method: string;
    canonical_url: string;
    status: number;
    response_headers?: Record<string, string>;
    body_digest_sha256?: string | null;
    body_omitted_reason?: string;
    response_fields?: unknown;
    request_body_digest_sha256?: string | null;
  }>;
  attributed_from?: ProviderFixturePack['attributed_from'];
}): ProviderFixturePack {
  const http_exchanges: HttpFixtureExchange[] = input.exchanges.map((exchange) => {
    const provider = exchange.provider === 'github' || exchange.provider === 'github_raw' || exchange.provider === 'npm'
      ? exchange.provider
      : 'unknown';
    const hasFields = exchange.response_fields !== undefined;
    const omitted = !hasFields;
    return {
      sequence: exchange.sequence,
      provider,
      match: {
        method: normalizeHttpMethod(exchange.method),
        canonical_url: normalizeRequestUrl(exchange.canonical_url),
        request_body_digest_sha256: exchange.request_body_digest_sha256 ?? null
      },
      response: {
        status: exchange.status,
        headers: stripForbiddenHeaders(exchange.response_headers ?? {}),
        body_encoding: omitted ? 'omitted' : 'json',
        ...(hasFields ? { body: exchange.response_fields } : {}),
        ...(omitted
          ? { body_omitted_reason: exchange.body_omitted_reason ?? 'capture_truncated_or_omitted' }
          : {})
      }
    } satisfies HttpFixtureExchange;
  });

  return ProviderFixturePackSchema.parse({
    fixture_version: 1,
    case_id: input.case_id,
    attributed_from: input.attributed_from,
    http_exchanges,
    git_probes: []
  });
}

export function casePromotionToProviderPack(fixture: CasePromotionFixture, caseId: string): ProviderFixturePack {
  return captureExchangesToProviderPack({
    case_id: caseId,
    exchanges: fixture.replay.exchanges.map((exchange) => ({
      ...exchange,
      request_body_digest_sha256: null
    })),
    attributed_from: {
      capture_id: fixture.source.capture_id,
      capture_created_at: fixture.source.capture_created_at,
      gitworthy_version: fixture.source.gitworthy_version
    }
  });
}

function stripForbiddenHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'authorization'
      || lower === 'proxy-authorization'
      || lower === 'cookie'
      || lower === 'set-cookie'
      || lower === 'x-access-token'
      || lower === 'x-github-token'
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Stable helper for tests / diagnostics. */
export function fixtureBodyDigest(body: unknown, encoding: 'json' | 'text' | 'base64'): string {
  if (encoding === 'json') return digestUtf8(JSON.stringify(body ?? null));
  if (encoding === 'text') return digestUtf8(typeof body === 'string' ? body : String(body ?? ''));
  return digestUtf8(typeof body === 'string' ? body : '');
}
