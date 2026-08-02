import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const MCP_TOKEN_ENV = 'GITWORTHY_MCP_TOKEN';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized);
}

export function isPublicBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

/** True when the listen address is reachable beyond the local machine. */
export function requiresMcpTokenForBind(host: string): boolean {
  return isPublicBindHost(host) || !isLoopbackHost(host);
}

export function resolveMcpToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[MCP_TOKEN_ENV]?.trim();
  return value ? value : undefined;
}

export function assertHttpBindAllowed(input: {
  host: string;
  token?: string;
}): void {
  const token = input.token?.trim();
  if (requiresMcpTokenForBind(input.host) && !token) {
    throw new Error(
      `Refusing to bind MCP HTTP on ${input.host} without ${MCP_TOKEN_ENV}. ` +
        'Set a bearer token before exposing Streamable HTTP beyond loopback.'
    );
  }
}

function safeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Extract Bearer token from an Authorization header value. */
export function bearerTokenFromAuthorization(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

export function authorizeMcpRequest(input: {
  authorizationHeader?: string | null;
  expectedToken?: string;
  /** Explicit opt-in for tokenless loopback only. Default: fail closed. */
  allowUnauthenticated?: boolean;
}): { ok: true } | { ok: false; status: 401; message: string } {
  const expected = input.expectedToken?.trim();
  if (!expected) {
    if (input.allowUnauthenticated) return { ok: true };
    return {
      ok: false,
      status: 401,
      message: `Unauthorized: set ${MCP_TOKEN_ENV} and send Authorization Bearer token.`
    };
  }
  const provided = bearerTokenFromAuthorization(input.authorizationHeader);
  if (!provided || !safeEqualString(provided, expected)) {
    return {
      ok: false,
      status: 401,
      message: 'Unauthorized: valid Authorization Bearer token required.'
    };
  }
  return { ok: true };
}

export function authorizationFromNodeRequest(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Hostname from a Host header (strips port; keeps IPv6 bracket form when present). */
export function hostnameFromHostHeader(hostHeader: string | null | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const raw = hostHeader.trim().toLowerCase();
  if (!raw) return undefined;
  try {
    // URL parser handles host:port and [ipv6]:port correctly.
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.replace(/:\d+$/, '');
  }
}

export const DEFAULT_LOOPBACK_ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/**
 * Resolve Host allow-list.
 * Tokenless loopback defaults to localhost hosts (DNS-rebinding protection).
 * Public binds with a token may omit the list (auth is the gate) unless configured.
 */
export function resolveAllowedHosts(input: {
  host: string;
  token?: string;
  allowedHosts?: string[];
}): string[] | undefined {
  if (input.allowedHosts && input.allowedHosts.length > 0) return input.allowedHosts;
  if (!input.token?.trim() && isLoopbackHost(input.host)) {
    return [...DEFAULT_LOOPBACK_ALLOWED_HOSTS];
  }
  return undefined;
}

export function hostHeaderAllowed(input: {
  hostHeader?: string | null;
  allowedHosts?: string[];
}): boolean {
  if (!input.allowedHosts || input.allowedHosts.length === 0) return true;
  const hostname = hostnameFromHostHeader(input.hostHeader);
  if (!hostname) return false;
  const raw = input.hostHeader?.trim().toLowerCase() ?? '';
  return input.allowedHosts.some((allowed) => {
    const needle = allowed.trim().toLowerCase();
    if (!needle) return false;
    if (needle === raw || needle === hostname) return true;
    const allowedHost = hostnameFromHostHeader(needle);
    return Boolean(allowedHost && allowedHost === hostname);
  });
}
