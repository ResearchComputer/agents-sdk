import { describe, it, expect } from 'vitest';
import { safeToolError, safePathError, safeInvalidInputError } from './safe-error.js';
import { ToolExecutionError } from '../../core/errors.js';

describe('safeToolError', () => {
  it('maps ENOENT to not_found', () => {
    const err = Object.assign(new Error('open /etc/shadow'), { code: 'ENOENT' });
    const e = safeToolError(err, 'io_error');
    expect(e).toBeInstanceOf(ToolExecutionError);
    expect(e.message).toBe('[not_found] operation failed');
  });

  it('maps EACCES / EPERM to permission_denied', () => {
    const e = safeToolError(Object.assign(new Error('denied'), { code: 'EACCES' }), 'io_error');
    expect(e.message).toBe('[permission_denied] operation failed');
  });

  it('maps ELOOP (symlink loop) to permission_denied — hides symlink-swap details', () => {
    const e = safeToolError(Object.assign(new Error('loop'), { code: 'ELOOP' }), 'io_error');
    expect(e.message).toBe('[permission_denied] operation failed');
  });

  it('uses fallback code when errno is unknown', () => {
    const e = safeToolError(new Error('something weird'), 'fetch_failed');
    expect(e.message).toBe('[fetch_failed] operation failed');
  });

  it('never embeds the underlying error message', () => {
    const e = safeToolError(new Error('/home/user/secret.txt contains SECRET=abc'), 'io_error');
    expect(e.message).not.toContain('/home/user/secret.txt');
    expect(e.message).not.toContain('SECRET=abc');
  });

  it('preserves the original error as .cause for host-side logging', () => {
    const original = new Error('underlying');
    const e = safeToolError(original, 'io_error');
    expect((e as Error & { cause?: unknown }).cause).toBe(original);
  });
});

describe('safePathError', () => {
  it('returns a bounded message with no path', () => {
    const e = safePathError('write');
    expect(e.message).toBe('[path_not_allowed] write denied');
  });
});

describe('safeInvalidInputError', () => {
  it('only accepts developer-supplied hints', () => {
    const e = safeInvalidInputError('pattern starts with dash');
    expect(e.message).toBe('[invalid_input] pattern starts with dash');
  });
});
