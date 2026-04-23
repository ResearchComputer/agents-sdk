const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(ms: number): string {
  // 10 chars of Crockford Base32 = 50 bits; we use 48 (the two high bits stay 0).
  let result = '';
  for (let i = 0; i < 10; i++) {
    const mod = ms % 32;
    result = CROCKFORD[mod] + result;
    ms = (ms - mod) / 32;
  }
  return result;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += CROCKFORD[bytes[i] % 32];
  }
  return result;
}

export function newUlid(): string {
  return encodeTime(Date.now()) + encodeRandom();
}

export function isUlid(s: string): boolean {
  return typeof s === 'string' && ULID_RE.test(s);
}

export function nowIso(): string {
  return new Date().toISOString();
}
