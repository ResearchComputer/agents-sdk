import { ToolExecutionError } from '../../core/errors.js';

/**
 * Normalized error codes that tools surface to the LLM. Keep the set small
 * and avoid leaking LLM-controlled strings (paths, URLs, errno messages)
 * into the error payload — those show up in tool error messages, telemetry,
 * trajectory JSONL, and terminal output, where they can be used for
 * filesystem enumeration or ANSI-escape log poisoning.
 */
export type ToolErrorCode =
  | 'path_not_allowed'
  | 'not_found'
  | 'permission_denied'
  | 'io_error'
  | 'fetch_failed'
  | 'spawn_failed'
  | 'invalid_input'
  | 'timeout'
  | 'binary_file';

function mapErrnoToCode(err: unknown, fallback: ToolErrorCode): ToolErrorCode {
  const code = (err as { code?: unknown })?.code;
  if (code === 'ENOENT') return 'not_found';
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') return 'timeout';
  if (code === 'ELOOP') return 'permission_denied';
  return fallback;
}

/**
 * Build a ToolExecutionError whose message is a short, bounded code string
 * with no LLM-supplied content embedded. The underlying error is kept as
 * `.cause` for internal logging (host stderr, telemetry with redaction),
 * but does not end up in the LLM's context.
 */
export function safeToolError(err: unknown, fallback: ToolErrorCode): ToolExecutionError {
  const code = mapErrnoToCode(err, fallback);
  const e = new ToolExecutionError(`[${code}] operation failed`);
  (e as Error & { cause?: unknown }).cause = err;
  return e;
}

/** Path-denial error: explicit, never includes the offending path in the message. */
export function safePathError(operation: 'read' | 'write' | 'edit' | 'list'): ToolExecutionError {
  return new ToolExecutionError(`[path_not_allowed] ${operation} denied`);
}

/** Invalid input error — e.g. dash-prefixed arg that would be parsed as a flag. */
export function safeInvalidInputError(hint: string): ToolExecutionError {
  // `hint` is a developer-supplied constant, not LLM-controlled, so it's safe
  // to include. Callers must never pass user/LLM strings here.
  return new ToolExecutionError(`[invalid_input] ${hint}`);
}
