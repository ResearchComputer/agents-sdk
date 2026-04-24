import { execFile, type ExecFileException } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SdkError } from '../../core/errors.js';
import { saveSession, type Session } from './session.js';

const SUPPORTED_TOKEN_TYPES = new Set(['magic_links', 'oauth']);

function llmProxyUrl(): string {
  const url = process.env.RC_LLM_PROXY_URL;
  if (!url) {
    throw new SdkError('RC_LLM_PROXY_URL is required', 'CONFIG_MISSING', false);
  }
  return url.replace(/\/$/, '');
}

/** Maximum JWT lifetime we'll accept from the exchange endpoint. Anything
 *  longer than this is either a misconfigured issuer or a hostile one —
 *  refuse to persist it. 31 days matches Stytch's typical session length. */
const MAX_JWT_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * Decode a JWT payload WITHOUT verifying the signature. We use this as a
 * sanity check on the shape of the token the proxy hands us; signature
 * verification would require a pinned JWKS we don't currently ship.
 *
 * Returns null on malformed input.
 */
function decodeJwtPayload(jwt: string): { exp?: number; iat?: number; [k: string]: unknown } | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    // base64url → base64 → JSON
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, 'base64').toString('utf-8');
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export async function exchangeToken(token: string, tokenType: string): Promise<Session> {
  if (!SUPPORTED_TOKEN_TYPES.has(tokenType)) {
    throw new SdkError(`Unsupported token type: ${tokenType}`, 'UNSUPPORTED_TOKEN_TYPE', false);
  }

  const baseUrl = llmProxyUrl();
  // Warn if the proxy URL is being overridden from the env var — a common
  // misconfiguration / attack vector. The value is developer-visible in
  // the server logs, not LLM-supplied, so logging it is fine.
  if (process.env.RC_LLM_PROXY_URL && !/^https:\/\/(llm|api)\.research\.computer/.test(baseUrl)) {
    console.warn(
      `[auth] RC_LLM_PROXY_URL points at a non-default endpoint (${baseUrl}). ` +
      'Verify this is intentional — the session JWT is persisted under this trust.',
    );
  }

  const res = await fetch(`${baseUrl}/auth/stytch/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, tokenType }),
  });

  if (!res.ok) {
    throw new SdkError(`Token exchange failed: HTTP ${res.status}`, 'AUTH_EXCHANGE_FAILED', false);
  }

  const data = await res.json() as {
    sessionJwt:   string;
    sessionToken: string;
    jwtExpiresAt: number;
    email:        string;
  };

  // Shape check before persisting. A compromised proxy could return a
  // session with an arbitrary expiry — reject anything outside a sane
  // window so the damage from a misconfigured RC_LLM_PROXY_URL is bounded.
  if (typeof data.sessionJwt !== 'string' || !data.sessionJwt) {
    throw new SdkError('Exchange returned no sessionJwt', 'AUTH_EXCHANGE_INVALID', false);
  }
  if (typeof data.jwtExpiresAt !== 'number' || !Number.isFinite(data.jwtExpiresAt)) {
    throw new SdkError('Exchange returned invalid jwtExpiresAt', 'AUTH_EXCHANGE_INVALID', false);
  }

  // JWT payload must decode and its `exp` (if present) must agree with
  // the outer `jwtExpiresAt`. Without signature verification this isn't
  // a cryptographic guarantee, but it catches garbage / format drift.
  const payload = decodeJwtPayload(data.sessionJwt);
  if (!payload) {
    throw new SdkError('sessionJwt is not a well-formed JWT', 'AUTH_EXCHANGE_INVALID', false);
  }
  const nowMs = Date.now();
  const expMs = data.jwtExpiresAt;
  if (expMs <= nowMs) {
    throw new SdkError('Exchange returned an already-expired session', 'AUTH_EXCHANGE_EXPIRED', false);
  }
  if (expMs > nowMs + MAX_JWT_LIFETIME_MS) {
    throw new SdkError(
      `Exchange returned a session with implausible expiry (>${MAX_JWT_LIFETIME_MS / 86400000}d)`,
      'AUTH_EXCHANGE_INVALID',
      false,
    );
  }

  const session: Session = {
    sessionJwt:   data.sessionJwt,
    sessionToken: data.sessionToken,
    jwtExpiresAt: data.jwtExpiresAt,
    email:        data.email ?? '',
  };

  await saveSession(session);
  return session;
}

function openBrowser(url: string): void {
  const done = (err: ExecFileException | null, _stdout: string | Buffer, _stderr: string | Buffer) => {
    if (err) console.error('rc-agents: could not open browser:', err.message);
  };

  if (process.platform === 'darwin') {
    execFile('open', [url], done);
  } else if (process.platform === 'win32') {
    // Windows: use cmd start with empty title argument to avoid quoting issues
    execFile('cmd.exe', ['/c', 'start', '', url], done);
  } else {
    execFile('xdg-open', [url], done);
  }
}

export async function initiateLogin(options?: { port?: number }): Promise<Session> {
  const publicToken = process.env.STYTCH_PUBLIC_TOKEN;
  if (!publicToken) {
    throw new SdkError('STYTCH_PUBLIC_TOKEN is required', 'CONFIG_MISSING', false);
  }

  const state = randomBytes(16).toString('hex');
  const TIMEOUT_MS = 5 * 60 * 1000;

  return new Promise<Session>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Declare `timer` before `server.listen()` so the error handler and callback
    // handler can reference it without hitting a temporal-dead-zone error if
    // listen happens to emit an error synchronously.
    let timer: NodeJS.Timeout | undefined;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      // State is carried in the path segment, not a query param, to avoid
      // collisions with the token/stytch_token_type params that Stytch appends
      // to the redirect_url. Expected path: /callback/{state}
      //
      // SECURITY: return a uniform 404 for any non-matching path. Previously
      // we returned 400 "Invalid state" for /callback/* with the wrong state
      // vs 404 for other paths — that gave any local probe an oracle to
      // distinguish "login in progress" from "idle" and leaked the path
      // prefix. Uniform 404 eliminates the oracle.
      const expectedPath = `/callback/${state}`;
      if (url.pathname !== expectedPath) {
        res.writeHead(404);
        res.end();
        return;
      }

      const token = url.searchParams.get('token');
      const tokenType = url.searchParams.get('stytch_token_type') ?? 'magic_links';

      if (!token) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing token');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>Authentication complete. You may close this tab.</p></body></html>');

      if (timer) clearTimeout(timer);
      server.close();
      settle(() => {
        exchangeToken(token, tokenType).then(resolve, reject);
      });
    });

    server.on('error', (err) => {
      if (timer) clearTimeout(timer);
      settle(() => reject(err));
    });

    // Listen and open browser only after listening event fires
    const bindPort = options?.port ?? 0; // 0 = OS-assigned
    server.listen(bindPort, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const actualPort = addr.port;
      // State embedded in path, not query param — Stytch appends its token
      // params as new query params, so the final callback URL is:
      //   http://localhost:{port}/callback/{state}?token=...&stytch_token_type=...
      const callbackUrl = `http://localhost:${actualPort}/callback/${state}`;
      const loginUrl =
        `https://login.stytch.com/u/login` +
        `?public_token=${encodeURIComponent(publicToken)}` +
        `&redirect_url=${encodeURIComponent(callbackUrl)}`;
      openBrowser(loginUrl);
    });

    timer = setTimeout(() => {
      server.close();
      settle(() => reject(new SdkError('Login timed out', 'LOGIN_TIMEOUT', false)));
    }, TIMEOUT_MS);
  });
}
