/**
 * Signature compatible with CoreAdapters.redactArgs / AgentConfig.redactArgs.
 * Called before the SDK writes tool arguments into a trajectory event or
 * permission_decision payload.
 */
export type RedactArgsFn = (toolName: string, args: unknown) => unknown;

export interface KeyRedactorOptions {
  /** If true, match keys case-insensitively (e.g. `Authorization` == `authorization`). */
  caseInsensitive?: boolean;
  /** If provided, the redactor is a no-op for tools where this returns false. */
  toolFilter?: (toolName: string) => boolean;
  /** Override the replacement sentinel. Default: "[redacted]". */
  replacement?: string;
}

/**
 * Build a `redactArgs` function that walks an args value recursively and
 * replaces any object property whose name matches one of `keys` with
 * `[redacted]`. Non-object values pass through unchanged.
 *
 * Intentionally simple: this is NOT a secret scanner — it's a
 * caller-declared allowlist of fields to scrub. No heuristics, no regex
 * matching on values, no entropy detection. Built-in heuristics give a
 * false sense of security and the SDK deliberately doesn't ship them.
 */
export function createKeyRedactor(
  keys: string[],
  options: KeyRedactorOptions = {},
): RedactArgsFn {
  const replacement = options.replacement ?? '[redacted]';
  const ci = options.caseInsensitive ?? false;
  const normalized = ci ? new Set(keys.map(k => k.toLowerCase())) : new Set(keys);
  const matches = ci
    ? (k: string): boolean => normalized.has(k.toLowerCase())
    : (k: string): boolean => normalized.has(k);

  function redact(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(redact);
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = matches(k) ? replacement : redact(v);
      }
      return out;
    }
    return value;
  }

  return (toolName: string, args: unknown): unknown => {
    if (options.toolFilter && !options.toolFilter(toolName)) return args;
    return redact(args);
  };
}
