import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const MCP_TOKEN_ENV = 'GITWORTHY_MCP_TOKEN';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  // Strip optional brackets / zone id variants.
  if (normalized === '::1' || normalized === '[::1]') return true;
  return false;
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
    // Compare against itself to keep the timing roughly constant on length mismatch.
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
}): { ok: true } | { ok: false; status: 401; message: string } {
  const expected = input.expectedToken?.trim();
  if (!expected) {
    // Loopback-only unauthenticated mode.
    return { ok: true };
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

export function hostHeaderAllowed(input: {
  hostHeader?: string | null;
  allowedHosts?: string[];
}): boolean {
  if (!input.allowedHosts || input.allowedHosts.length === 0) return true;
  const raw = input.hostHeader?.trim().toLowerCase();
  if (!raw) return false;
  // Host may include port.
  const hostname = raw.replace(/:\d+$/, '');
  return input.allowedHosts.some((allowed) => {
    const needle = allowed.trim().toLowerCase();
    return needle === raw || needle === hostname;
  });
}
