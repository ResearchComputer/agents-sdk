import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import { Type } from '@sinclair/typebox';
import type { SdkTool } from '../../core/types.js';
import { safeToolError, safeInvalidInputError } from '../security/index.js';

const WebFetchParams = Type.Object({
  url: Type.String(),
});

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 100 * 1024;

/**
 * Text-ish content types we accept by default. Binary / unknown types are
 * rejected to avoid crammed `text` blocks with mojibake'd bytes. Callers
 * can broaden via WebFetchToolOptions.contentTypeAllowlist.
 */
const DEFAULT_CONTENT_TYPES = [
  'text/',
  'application/json',
  'application/xml',
  'application/xhtml',
  'application/javascript',
  'application/ld+json',
];

export interface WebFetchToolOptions {
  /**
   * Override the default content-type allowlist. Matches with a simple
   * prefix check against the response's Content-Type (case-insensitive,
   * parameters stripped).
   */
  contentTypeAllowlist?: string[];
  /**
   * Soft byte cap. Body reading aborts past this; the returned payload
   * carries `{ truncated: true }` in `details`. Default 100 KiB.
   */
  maxBytes?: number;
  /**
   * Override the DNS resolver. Mostly for tests; production callers should
   * use the default (node:dns/promises lookup with `all: true`).
   */
  lookupHost?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;
}

/**
 * RFC 1918 + loopback + link-local + IETF-protocol IPv4 blocklist. A
 * resolved address in any of these ranges is rejected. The `0.0.0.0`
 * unspecified address is also rejected — on Linux it routes to every
 * listening socket on the box.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    // If we can't parse it, err on the side of blocking.
    return true;
  }
  const [a, b] = parts;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local — includes AWS/GCP IMDS 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24, 192.0.2.0/24 (docs), 192.88.99.0/24, 192.168.0.0/16
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 88 && parts[2] === 99) return true;
  // 198.18.0.0/15 (benchmark), 198.51.100.0/24 (docs)
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  // 203.0.113.0/24 (docs)
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  // 224.0.0.0/4 (multicast), 240.0.0.0/4 (future/broadcast)
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  if (norm === '::' || norm === '::1') return true;
  // fc00::/7 (unique local)
  if (/^f[cd]/i.test(norm)) return true;
  // fe80::/10 (link-local)
  if (/^fe[89ab]/i.test(norm)) return true;
  // ff00::/8 (multicast)
  if (/^ff/i.test(norm)) return true;
  // IPv4-mapped: ::ffff:a.b.c.d — re-check the IPv4 part
  const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

type HostLookupFn = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

const defaultLookup: HostLookupFn = async (hostname) => {
  const addrs = await dns.lookup(hostname, { all: true });
  return addrs.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
};

async function assertPublicHost(hostname: string, lookup: HostLookupFn): Promise<void> {
  // The WHATWG URL parser sometimes leaves IPv6 literals bracketed in
  // `url.hostname` (e.g. `[::1]`). Strip brackets before the net.isIPv6 check.
  const h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  // IP literal? validate directly without DNS.
  if (net.isIPv4(h)) {
    if (isPrivateIPv4(h)) throw safeInvalidInputError('host not allowed');
    return;
  }
  if (net.isIPv6(h)) {
    if (isPrivateIPv6(h)) throw safeInvalidInputError('host not allowed');
    return;
  }
  // Hostname → resolve ALL addresses (A + AAAA) and block if ANY is private.
  // This is not full DNS-rebinding protection (the next connection may resolve
  // differently), but it closes the common case of `localhost`/IMDS hostnames.
  let addrs: { address: string; family: 4 | 6 }[];
  try {
    addrs = await lookup(h);
  } catch (err) {
    throw safeToolError(err, 'fetch_failed');
  }
  for (const a of addrs) {
    const blocked = a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIPv6(a.address);
    if (blocked) throw safeInvalidInputError('host not allowed');
  }
}

function contentTypeAllowed(
  ct: string | null,
  allowlist: string[],
): boolean {
  if (!ct) return false;
  const lower = ct.split(';')[0].trim().toLowerCase();
  return allowlist.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

export function createWebFetchTool(
  options: WebFetchToolOptions = {},
): SdkTool<typeof WebFetchParams> {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const contentTypes = options.contentTypeAllowlist ?? DEFAULT_CONTENT_TYPES;
  const lookup: HostLookupFn = options.lookupHost ?? defaultLookup;

  return {
    name: 'WebFetch',
    label: 'Fetch URL content',
    description: 'Fetches content from a URL (http/https only).',
    parameters: WebFetchParams,
    capabilities: ['network:egress'],
    async execute(_toolCallId, params, signal) {
      let currentUrl: URL;
      try {
        currentUrl = new URL(params.url);
      } catch {
        throw safeInvalidInputError('invalid URL');
      }
      if (!ALLOWED_SCHEMES.has(currentUrl.protocol)) {
        throw safeInvalidInputError('scheme not allowed');
      }

      // Manual redirect loop. Re-validate scheme + host on every hop —
      // a 302 from a public host can point at 169.254.169.254.
      let hops = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await assertPublicHost(currentUrl.hostname, lookup);
        let response: Response;
        try {
          response = await fetch(currentUrl, { redirect: 'manual', signal });
        } catch (err) {
          // Network errors, DNS failures, aborts — normalize so the LLM
          // never sees raw errno text or URL fragments from the node runtime.
          throw safeToolError(err, 'fetch_failed');
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            throw safeToolError(
              new Error('redirect without Location'),
              'fetch_failed',
            );
          }
          hops++;
          if (hops > MAX_REDIRECTS) {
            throw safeInvalidInputError('too many redirects');
          }
          try {
            currentUrl = new URL(location, currentUrl);
          } catch {
            throw safeInvalidInputError('invalid redirect URL');
          }
          if (!ALLOWED_SCHEMES.has(currentUrl.protocol)) {
            throw safeInvalidInputError('redirect scheme not allowed');
          }
          continue;
        }

        if (!response.ok) {
          // Bounded error — do not embed response body or status text with
          // LLM-visible content (status text is server-controlled).
          throw safeToolError(
            new Error(`non-2xx status ${response.status}`),
            'fetch_failed',
          );
        }

        if (!contentTypeAllowed(response.headers.get('content-type'), contentTypes)) {
          throw safeInvalidInputError('content type not allowed');
        }

        // Stream the body with a hard byte cap. `response.text()` would
        // buffer the whole body first, OOM-ing on a huge `Content-Length`.
        const { text, truncated } = await readBodyCapped(response, maxBytes, signal);

        return {
          content: [{ type: 'text' as const, text }],
          details: {
            url: currentUrl.toString(),
            status: response.status,
            contentType: response.headers.get('content-type') ?? '',
            truncated,
          },
        };
      }
    },
  };
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    // Some mocks return no body stream; fall back to text() with size check.
    const t = await response.text();
    if (t.length > maxBytes) return { text: t.slice(0, maxBytes), truncated: true };
    return { text: t, truncated: false };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let text = '';
  let truncated = false;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) {
        reader.cancel().catch(() => {});
        throw safeToolError(new Error('aborted'), 'timeout');
      }
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      total += chunk.byteLength;
      if (total > maxBytes) {
        const remaining = Math.max(0, maxBytes - (total - chunk.byteLength));
        text += decoder.decode(chunk.subarray(0, remaining), { stream: false });
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }
      text += decoder.decode(chunk, { stream: true });
    }
    if (!truncated) {
      text += decoder.decode();
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text, truncated };
}
