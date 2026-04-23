export function generateTraceId(): string {
  return globalThis.crypto.randomUUID();
}
