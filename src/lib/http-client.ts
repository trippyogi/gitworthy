/** Shared bounded HTTP client for GitHub / npm providers (GW-011). */

export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
export const DEFAULT_HTTP_MAX_RETRIES = 2;
export const DEFAULT_GITHUB_API_VERSION = '2022-11-28';
export const DEFAULT_USER_AGENT = 'gitworthy';

const RETRYABLE_5XX = new Set([500, 502, 503, 504]);
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;

export type HttpTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type RateLimitMeta = {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  resource: string | null;
  retryAfterMs: number | null;
};

export type RequestBudget = {
  maxRequests: number;
  usedRequests: number;
};

export type HttpLogEvent = {
  level: 'info' | 'warn' | 'error';
  message: string;
  url: string;
  method: string;
  status?: number;
  attempt: number;
  delayMs?: number;
  headers?: Record<string, string>;
};

export type HttpClientOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  budget?: RequestBudget;
  transport?: HttpTransport;
  baseHeaders?: RequestInit['headers'];
  userAgent?: string;
  githubApiVersion?: string;
  logger?: (event: HttpLogEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type HttpRequestOptions = {
  method?: string;
  headers?: RequestInit['headers'];
  body?: RequestInit['body'];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  /** When false, skip GitHub API version / accept defaults (e.g. npm / raw). */
  github?: boolean;
};

export type HttpResult = {
  response: Response;
  rateLimit: RateLimitMeta;
  attempts: number;
};

export class HttpClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly rateLimit?: RateLimitMeta;
  readonly attempts?: number;

  constructor(input: {
    code: string;
    message: string;
    status?: number;
    rateLimit?: RateLimitMeta;
    attempts?: number;
  }) {
    super(input.message);
    this.name = 'HttpClientError';
    this.code = input.code;
    this.status = input.status;
    this.rateLimit = input.rateLimit;
    this.attempts = input.attempts;
  }
}

export function createRequestBudget(maxRequests: number): RequestBudget {
  return { maxRequests, usedRequests: 0 };
}

export function resetRequestBudget(budget: RequestBudget): void {
  budget.usedRequests = 0;
}

export function parseRateLimit(headers: Headers): RateLimitMeta {
  return {
    limit: parseOptionalInt(headers.get('x-ratelimit-limit')),
    remaining: parseOptionalInt(headers.get('x-ratelimit-remaining')),
    reset: parseOptionalInt(headers.get('x-ratelimit-reset')),
    resource: headers.get('x-ratelimit-resource'),
    retryAfterMs: parseRetryAfterMs(headers.get('retry-after'))
  };
}

export function redactHeaders(headers: RequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const normalized = headers instanceof Headers ? headers : new Headers(headers);
  normalized.forEach((value, key) => {
    out[key] = SENSITIVE_HEADER.test(key) ? '[redacted]' : value;
  });
  return out;
}

export function githubApiHeaders(token?: string, apiVersion = DEFAULT_GITHUB_API_VERSION): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': DEFAULT_USER_AGENT,
    'x-github-api-version': apiVersion
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  return new HttpClient(options);
}

export class HttpClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly budget: RequestBudget | undefined;
  private readonly transport: HttpTransport;
  private readonly baseHeaders: RequestInit['headers'] | undefined;
  private readonly userAgent: string;
  private readonly githubApiVersion: string;
  private readonly logger: ((event: HttpLogEvent) => void) | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: HttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_HTTP_MAX_RETRIES;
    this.budget = options.budget;
    // Resolve global fetch at call time so test stubs (vi.stubGlobal) still apply.
    this.transport = options.transport ?? ((input, init) => fetch(input, init));
    this.baseHeaders = options.baseHeaders;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.githubApiVersion = options.githubApiVersion ?? DEFAULT_GITHUB_API_VERSION;
    this.logger = options.logger;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  getBudget(): RequestBudget | undefined {
    return this.budget;
  }

  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResult> {
    const method = (options.method ?? 'GET').toUpperCase();
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let attempt = 0;

    while (true) {
      this.consumeBudget(url, method, attempt);
      attempt += 1;

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      const headers = this.buildHeaders(options);

      let response: Response;
      try {
        response = await this.transport(url, {
          method,
          headers,
          body: options.body,
          signal
        });
      } catch (error) {
        if (isAbortError(error)) {
          if (options.signal?.aborted) throw error;
          throw new HttpClientError({
            code: 'http_timeout',
            message: `HTTP request timed out after ${timeoutMs}ms for ${redactUrl(url)}.`,
            attempts: attempt
          });
        }
        throw error;
      }

      const rateLimit = parseRateLimit(response.headers);

      if (response.ok) {
        return { response, rateLimit, attempts: attempt };
      }

      const retryable = await this.isRetryable(response, attempt, maxRetries);
      if (!retryable) {
        return { response, rateLimit, attempts: attempt };
      }

      const delayMs = this.retryDelayMs(rateLimit, attempt);
      this.logger?.({
        level: 'warn',
        message: 'retrying HTTP request after transient failure',
        url: redactUrl(url),
        method,
        status: response.status,
        attempt,
        delayMs,
        headers: redactHeaders(response.headers)
      });
      // Drain/cancel body so the socket can be reused before sleeping.
      try {
        await response.arrayBuffer();
      } catch {
        // ignore body drain failures
      }
      await this.sleep(delayMs);
    }
  }

  private consumeBudget(url: string, method: string, attempt: number): void {
    if (!this.budget) return;
    if (this.budget.usedRequests >= this.budget.maxRequests) {
      this.logger?.({
        level: 'error',
        message: 'HTTP request budget exceeded',
        url: redactUrl(url),
        method,
        attempt: attempt + 1
      });
      throw new HttpClientError({
        code: 'http_budget_exceeded',
        message: `HTTP request budget exceeded (${this.budget.usedRequests}/${this.budget.maxRequests}).`,
        attempts: attempt
      });
    }
    this.budget.usedRequests += 1;
  }

  private buildHeaders(options: HttpRequestOptions): Headers {
    const headers = new Headers(this.baseHeaders);
    if (!headers.has('user-agent')) headers.set('user-agent', this.userAgent);
    if (options.github !== false) {
      if (!headers.has('accept')) headers.set('accept', 'application/vnd.github+json');
      if (!headers.has('x-github-api-version')) headers.set('x-github-api-version', this.githubApiVersion);
    }
    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }
    return headers;
  }

  private async isRetryable(response: Response, attempt: number, maxRetries: number): Promise<boolean> {
    if (attempt > maxRetries) return false;
    const status = response.status;
    if (status === 401 || status === 404 || status === 422) return false;
    if (status === 429) return true;
    if (RETRYABLE_5XX.has(status)) return true;
    if (status === 403) return isSafeSecondaryRateLimit(response);
    return false;
  }

  private retryDelayMs(rateLimit: RateLimitMeta, attempt: number): number {
    if (rateLimit.retryAfterMs != null) return rateLimit.retryAfterMs;
    // Bounded exponential backoff with full jitter: [0, base * 2^(attempt-1)]
    const baseMs = 250;
    const capMs = 8_000;
    const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
    return Math.floor(this.random() * exp);
  }
}

async function isSafeSecondaryRateLimit(response: Response): Promise<boolean> {
  // Primary quota exhaustion is not retried; callers surface it as rate_limit_exhausted.
  if (response.headers.get('x-ratelimit-remaining') === '0') return false;
  if (response.headers.has('retry-after')) return true;
  try {
    const body = await response.clone().text();
    return /secondary\s+rate\s+limit/i.test(body);
  } catch {
    return false;
  }
}

function parseOptionalInt(value: string | null): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value == null || value === '') return null;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds)) return Math.max(0, Math.floor(asSeconds * 1000));
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('access_token')) parsed.searchParams.set('access_token', '[redacted]');
    if (parsed.username) parsed.username = '[redacted]';
    if (parsed.password) parsed.password = '[redacted]';
    return parsed.toString();
  } catch {
    return url.replace(/([?&](?:access_token|token)=)[^&]*/gi, '$1[redacted]');
  }
}
