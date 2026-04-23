import { describe, it, expect } from 'vitest';
import { createKeyRedactor } from './redactors.js';

describe('createKeyRedactor', () => {
  it('replaces top-level keys in a plain object', () => {
    const r = createKeyRedactor(['password']);
    const out = r('Login', { user: 'a', password: 'secret' });
    expect(out).toEqual({ user: 'a', password: '[redacted]' });
  });

  it('replaces keys recursively in nested objects', () => {
    const r = createKeyRedactor(['apiKey']);
    const out = r('Http', { url: '/x', headers: { apiKey: 'k', other: 'v' } });
    expect(out).toEqual({ url: '/x', headers: { apiKey: '[redacted]', other: 'v' } });
  });

  it('replaces inside arrays of objects', () => {
    const r = createKeyRedactor(['token']);
    const out = r('Batch', {
      items: [
        { id: 1, token: 't1' },
        { id: 2, token: 't2' },
      ],
    });
    expect(out).toEqual({ items: [{ id: 1, token: '[redacted]' }, { id: 2, token: '[redacted]' }] });
  });

  it('is case-insensitive when configured', () => {
    const r = createKeyRedactor(['authorization'], { caseInsensitive: true });
    const out = r('Http', { Authorization: 'Bearer x' });
    expect(out).toEqual({ Authorization: '[redacted]' });
  });

  it('leaves non-matching args untouched', () => {
    const r = createKeyRedactor(['secret']);
    const args = { a: 1, b: 'two' };
    expect(r('Any', args)).toEqual(args);
  });

  it('returns non-object args (strings, numbers, null) unchanged', () => {
    const r = createKeyRedactor(['x']);
    expect(r('t', 'hello')).toBe('hello');
    expect(r('t', 42)).toBe(42);
    expect(r('t', null)).toBeNull();
  });

  it('respects a toolFilter to scope redaction per tool', () => {
    const r = createKeyRedactor(['command'], { toolFilter: (name) => name === 'Bash' });
    expect(r('Bash', { command: 'rm -rf /' })).toEqual({ command: '[redacted]' });
    expect(r('Read', { command: 'not-bash' })).toEqual({ command: 'not-bash' });
  });
});
