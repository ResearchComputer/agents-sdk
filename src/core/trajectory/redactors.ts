/**
 * Signature compatible with CoreAdapters.redactArgs / AgentConfig.redactArgs.
 * Called before the SDK writes tool arguments into a trajectory event or
 * permission_decision payload.
 */
export type RedactArgsFn = (toolName: string, args: unknown) => unknown;

/**
 * Signature compatible with CoreAdapters.redactMessages / AgentConfig.redactMessages.
 * Applied to AgentMessage arrays before they are written to trajectory events
 * (`llm_api_call.request_messages`, `agent_message.content`) and before upload.
 * Return a new array with sensitive content replaced; a throwing redactor
 * falls back to the original messages with a warning (the SDK never silently
 * drops a session over a redactor bug).
 */
export type RedactMessagesFn = (
  messages: import('@mariozechner/pi-agent-core').AgentMessage[],
) => import('@mariozechner/pi-agent-core').AgentMessage[];

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

export interface ContentRedactorOptions {
  /** Override the replacement sentinel. Default: "[redacted]". */
  replacement?: string;
  /** Additional user-supplied regex patterns to scrub. */
  extraPatterns?: RegExp[];
}

/**
 * Build a `redactMessages` function that scans text content in each
 * AgentMessage and replaces well-known secret patterns with a sentinel.
 *
 * Patterns covered:
 *   - AWS access key IDs:  AKIA[A-Z0-9]{16}
 *   - OpenAI-style keys:   sk-[A-Za-z0-9]{20,}
 *   - JWT tokens:          three base64url segments separated by dots
 *
 * Opt-in only; the factory never enables this by default. Callers combine
 * this with createKeyRedactor (for tool args) to cover both surfaces.
 */
export function createContentRedactor(
  options: ContentRedactorOptions = {},
): RedactMessagesFn {
  const replacement = options.replacement ?? '[redacted]';
  const patterns: RegExp[] = [
    /AKIA[A-Z0-9]{16}/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    ...(options.extraPatterns ?? []),
  ];

  const scrubText = (text: string): string =>
    patterns.reduce((acc, pattern) => acc.replace(pattern, replacement), text);

  const scrubContent = (content: unknown): unknown => {
    if (typeof content === 'string') return scrubText(content);
    if (Array.isArray(content)) {
      return content.map((block) => {
        if (
          block !== null &&
          typeof block === 'object' &&
          'type' in block &&
          (block as { type: unknown }).type === 'text' &&
          'text' in block
        ) {
          const text = (block as { text: unknown }).text;
          return { ...block, text: scrubText(String(text)) };
        }
        return block;
      });
    }
    return content;
  };

  return (messages) =>
    messages.map((msg) => ({
      ...msg,
      content: scrubContent((msg as { content?: unknown }).content),
    }) as typeof msg);
}
