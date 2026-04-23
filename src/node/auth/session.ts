import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface Session {
  sessionJwt:   string;
  sessionToken: string;
  jwtExpiresAt: number;  // epoch ms — when the current session_jwt expires (~5 min from issue)
  email:        string;  // may be empty for passkey-only users
}

const REFRESH_BUFFER_MS = 60 * 1000; // refresh when < 60 s remaining

function authFilePath(): string {
  return path.join(os.homedir(), '.rc-agents', 'auth.json');
}

function llmProxyUrl(): string {
  const url = process.env.RC_LLM_PROXY_URL;
  if (!url) {
    throw new Error('RC_LLM_PROXY_URL is required for auth operations');
  }
  return url.replace(/\/$/, ''); // strip trailing slash
}

export async function saveSession(session: Session): Promise<void> {
  const filePath = authFilePath();
  const tmp = filePath + '.tmp';
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // `mkdir` only applies `mode` on creation; re-assert permissions in case the
  // directory pre-existed with a looser mode (or was affected by umask).
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // chmod is best-effort — some filesystems don't support it
  }
  await fs.writeFile(tmp, JSON.stringify(session, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmp, filePath);
}

export async function getSession(): Promise<Session | null> {
  const filePath = authFilePath();
  let stored: Session;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    stored = JSON.parse(content) as Session;
  } catch {
    return null;
  }

  if (!stored.sessionJwt || !stored.sessionToken) return null;

  // JWT still valid with buffer — return as-is
  if (stored.jwtExpiresAt - Date.now() >= REFRESH_BUFFER_MS) {
    return stored;
  }

  // Needs refresh
  return refreshSession(stored);
}

/**
 * Returns the stored session if it still has positive JWT lifetime, otherwise null.
 * Used as a fallback when refresh fails for non-revocation reasons (config missing,
 * network error, 5xx). Avoids forcing re-login when the user's JWT is still technically
 * valid and the refresh failure was transient.
 */
function staleFallback(stored: Session): Session | null {
  return stored.jwtExpiresAt > Date.now() ? stored : null;
}

async function refreshSession(stored: Session): Promise<Session | null> {
  let baseUrl: string;
  try {
    baseUrl = llmProxyUrl();
  } catch {
    // RC_LLM_PROXY_URL not set — keep using the stored JWT if it still has life
    return staleFallback(stored);
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/auth/stytch/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: stored.sessionToken }),
    });
  } catch {
    // Network error — transient, not a revocation. Keep stored JWT if still valid.
    return staleFallback(stored);
  }

  // Only 401/403 means the session is definitively revoked — force re-login.
  if (res.status === 401 || res.status === 403) {
    return null;
  }

  // Any other non-ok (5xx, unexpected 4xx): treat as transient, return stale if valid.
  if (!res.ok) {
    return staleFallback(stored);
  }

  try {
    const data = await res.json() as {
      sessionJwt: string;
      sessionToken: string;
      jwtExpiresAt: number;
      email: string;
    };

    const refreshed: Session = {
      sessionJwt:   data.sessionJwt,
      sessionToken: data.sessionToken,
      jwtExpiresAt: data.jwtExpiresAt,
      email:        data.email || stored.email,
    };

    try {
      await saveSession(refreshed);
    } catch {
      // Disk error on save — return the refreshed session anyway. The next
      // getSession() call will see the old file and re-refresh.
    }
    return refreshed;
  } catch {
    // JSON parse error on a 2xx response — treat as transient
    return staleFallback(stored);
  }
}

export async function logout(): Promise<void> {
  const filePath = authFilePath();

  // Step 1: Read sessionToken if present
  let sessionToken: string | null = null;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const stored = JSON.parse(content) as Session;
    sessionToken = stored.sessionToken ?? null;
  } catch {
    // No session to revoke
  }

  // Step 2: Revoke via llm-proxy (best-effort, skipped if RC_LLM_PROXY_URL unset)
  if (sessionToken) {
    try {
      const baseUrl = llmProxyUrl();
      await fetch(`${baseUrl}/auth/stytch/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken }),
      });
    } catch (err) {
      console.error('rc-agents: failed to revoke session (continuing with local logout):', err);
    }
  }

  // Step 3: Delete local file (best-effort)
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore — file may already be gone
  }
}
