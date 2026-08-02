import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { CapturedExchange, CaptureManifest, CaptureMode, CaptureTarget } from '../contracts/capture.js';
import { CaptureManifestSchema } from '../contracts/capture.js';
import { SCHEMA_VERSION } from '../contracts/common.js';
import { packageVersion } from './package-meta.js';
import { redactHeaders, redactUrl, scrubJsonSecrets, scrubSecretText } from './redaction.js';

const MAX_CAPTURE_BODY_BYTES = 512 * 1024;
const MAX_FIELD_DEPTH = 5;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_KEYS = 80;
const MAX_STRING_LENGTH = 1_000;

type CaptureSource = {
  surface: 'cli' | 'mcp' | 'test' | 'unknown';
  attribution: string;
};

export type CaptureSessionOptions = {
  command: 'check' | 'hunt';
  capture_mode: CaptureMode;
  target: CaptureTarget;
  source: CaptureSource;
};

export class CaptureSession {
  readonly capture_id: string;
  readonly created_at: string;
  private readonly command: 'check' | 'hunt';
  private readonly capture_mode: CaptureMode;
  private readonly target: CaptureTarget;
  private readonly source: CaptureSource;
  private exchanges: CapturedExchange[] = [];
  private errors: string[] = [];
  private run_id: string | undefined;
  private decision_ids: string[] = [];

  constructor(options: CaptureSessionOptions) {
    this.capture_id = `capture_${randomUUID().replace(/-/g, '')}`;
    this.created_at = new Date().toISOString();
    this.command = options.command;
    this.capture_mode = options.capture_mode;
    this.target = options.target;
    this.source = options.source;
  }

  linkRun(input: { run_id?: string; decision_id?: string; decision_ids?: string[] }): void {
    if (input.run_id) this.run_id = input.run_id;
    const ids = [
      ...(input.decision_id ? [input.decision_id] : []),
      ...(input.decision_ids ?? [])
    ];
    for (const id of ids) {
      if (!this.decision_ids.includes(id)) this.decision_ids.push(id);
    }
  }

  noteError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message) this.errors.push(scrubSecretText(message));
  }

  async recordHttpExchange(input: {
    url: string;
    method: string;
    requestHeaders: RequestInit['headers'];
    requestBody?: RequestInit['body'];
    response: Response;
  }): Promise<void> {
    const sequence = this.exchanges.length;
    const responseHeaders = redactHeaders(input.response.headers);
    const body = await digestAndFields(input.response);
    const exchange = {
      sequence,
      captured_at: new Date().toISOString(),
      provider: providerForUrl(input.url),
      method: input.method.toUpperCase(),
      canonical_url: redactUrl(input.url),
      status: input.response.status,
      request_headers: redactHeaders(input.requestHeaders),
      response_headers: responseHeaders,
      request_body_digest_sha256: await digestRequestBody(input.requestBody),
      body_digest_sha256: body.digest,
      ...(body.omitted_reason ? { body_omitted_reason: body.omitted_reason } : {}),
      ...(body.fields !== undefined ? { response_fields: body.fields } : {})
    };
    this.exchanges.push(exchange);
  }

  manifest(): CaptureManifest {
    return CaptureManifestSchema.parse({
      schema_version: SCHEMA_VERSION,
      record_version: 1,
      record_kind: 'capture',
      capture_id: this.capture_id,
      created_at: this.created_at,
      updated_at: new Date().toISOString(),
      gitworthy_version: packageVersion(),
      run_id: this.run_id,
      decision_id: this.decision_ids[0],
      decision_ids: this.decision_ids,
      command: this.command,
      target: this.target,
      source: {
        surface: this.source.surface,
        requested_at: this.created_at,
        attribution: this.source.attribution
      },
      capture_mode: this.capture_mode,
      promotable: this.capture_mode === 'public' && this.target.is_private === false,
      exchanges: this.exchanges,
      errors: this.errors
    });
  }
}

const captureStorage = new AsyncLocalStorage<CaptureSession>();

export function currentCaptureSession(): CaptureSession | undefined {
  return captureStorage.getStore();
}

export async function withCaptureSession<T>(
  options: CaptureSessionOptions,
  run: (session: CaptureSession) => Promise<T>
): Promise<{ value: T; manifest: CaptureManifest }> {
  const session = new CaptureSession(options);
  return captureStorage.run(session, async () => {
    try {
      const value = await run(session);
      return { value, manifest: session.manifest() };
    } catch (error) {
      session.noteError(error);
      throw error;
    }
  });
}

export async function maybeCaptureHttpExchange(input: {
  url: string;
  method: string;
  requestHeaders: RequestInit['headers'];
  requestBody?: RequestInit['body'];
  response: Response;
}): Promise<void> {
  const session = currentCaptureSession();
  if (!session) return;
  try {
    await session.recordHttpExchange(input);
  } catch (error) {
    session.noteError(error);
  }
}

function providerForUrl(url: string): CapturedExchange['provider'] {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host === 'api.github.com') return 'github';
    if (host === 'raw.githubusercontent.com') return 'github_raw';
    if (host === 'registry.npmjs.org') return 'npm';
  } catch {
    // fall through
  }
  return 'unknown';
}

async function digestRequestBody(body: RequestInit['body'] | undefined): Promise<string | null> {
  if (body == null) return null;
  if (typeof body === 'string') return sha256(scrubSecretText(body));
  if (body instanceof URLSearchParams) return sha256(scrubSecretText(body.toString()));
  if (body instanceof ArrayBuffer) return sha256(Buffer.from(body));
  if (ArrayBuffer.isView(body)) return sha256(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  return null;
}

async function digestAndFields(response: Response): Promise<{
  digest: string | null;
  fields?: unknown;
  omitted_reason?: string;
}> {
  const contentType = response.headers.get('content-type') ?? '';
  const lengthRaw = response.headers.get('content-length');
  const length = lengthRaw ? Number(lengthRaw) : Number.NaN;
  if (Number.isFinite(length) && length > MAX_CAPTURE_BODY_BYTES) {
    return { digest: null, omitted_reason: `body omitted because content-length exceeded ${MAX_CAPTURE_BODY_BYTES} bytes` };
  }
  if (!/json|text|javascript|xml|yaml|plain/i.test(contentType) && contentType !== '') {
    return { digest: null, omitted_reason: `body omitted because content-type ${contentType} is not textual` };
  }
  try {
    const text = await response.clone().text();
    if (Buffer.byteLength(text, 'utf8') > MAX_CAPTURE_BODY_BYTES) {
      return { digest: null, omitted_reason: `body omitted because decoded body exceeded ${MAX_CAPTURE_BODY_BYTES} bytes` };
    }
    const scrubbed = scrubSecretText(text);
    const digest = sha256(scrubbed);
    if (/json/i.test(contentType) || looksJson(scrubbed)) {
      try {
        return { digest, fields: limitJson(scrubJsonSecrets(JSON.parse(scrubbed)), 0) };
      } catch {
        return { digest, fields: scrubbed.slice(0, MAX_STRING_LENGTH) };
      }
    }
    return { digest, fields: scrubbed.slice(0, MAX_STRING_LENGTH) };
  } catch (error) {
    return { digest: null, omitted_reason: `body omitted because it could not be cloned: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function limitJson(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_FIELD_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => limitJson(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    out[key] = limitJson(child, depth + 1);
  }
  return out;
}

function looksJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
