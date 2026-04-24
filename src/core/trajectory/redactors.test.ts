import { describe, it, expect } from 'vitest';
import { createKeyRedactor, createContentRedactor } from './redactors.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

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

describe('createContentRedactor', () => {
  const mkUserMsg = (text: string): AgentMessage => ({
    role: 'user',
    content: [{ type: 'text', text }],
  }) as unknown as AgentMessage;

  it('replaces AWS access key IDs', () => {
    const r = createContentRedactor();
    const out = r([mkUserMsg('use AKIAIOSFODNN7EXAMPLE for s3')]);
    const text = (out[0] as { content: { text: string }[] }).content[0].text;
    expect(text).not.toContain('AKIA');
    expect(text).toContain('[redacted]');
  });

  it('replaces OpenAI-style sk- keys', () => {
    const r = createContentRedactor();
    const out = r([mkUserMsg('my key is sk-abcdefghijklmnopqrstuvwxyz1234')]);
    const text = (out[0] as { content: { text: string }[] }).content[0].text;
    expect(text).not.toContain('sk-abcdef');
  });

  it('replaces JWT-shaped tokens', () => {
    const r = createContentRedactor();
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw.abcdefghijklmnop';
    const out = r([mkUserMsg(`Bearer ${jwt}`)]);
    const text = (out[0] as { content: { text: string }[] }).content[0].text;
    expect(text).not.toContain('eyJhbGci');
  });

  it('passes clean messages through unchanged', () => {
    const r = createContentRedactor();
    const out = r([mkUserMsg('hello world')]);
    const text = (out[0] as { content: { text: string }[] }).content[0].text;
    expect(text).toBe('hello world');
  });

  it('respects a custom replacement sentinel', () => {
    const r = createContentRedactor({ replacement: '***' });
    const out = r([mkUserMsg('AKIAIOSFODNN7EXAMPLE')]);
    const text = (out[0] as { content: { text: string }[] }).content[0].text;
    expect(text).toBe('***');
  });

  it('handles string-valued content directly', () => {
    const r = createContentRedactor();
    const msg = { role: 'user', content: 'AKIAIOSFODNN7EXAMPLE' } as unknown as AgentMessage;
    const out = r([msg]);
    expect((out[0] as { content: string }).content).toBe('[redacted]');
  });

  it('leaves non-text blocks unchanged', () => {
    const r = createContentRedactor();
    const msg = {
      role: 'user',
      content: [{ type: 'image', url: 'https://example.com/AKIA.png' }],
    } as unknown as AgentMessage;
    const out = r([msg]);
    const block = (out[0] as { content: { type: string; url?: string }[] }).content[0];
    expect(block.type).toBe('image');
    expect(block.url).toContain('AKIA');
  });

  it('applies extra caller-supplied patterns', () => {
    const r = createContentRedactor({ extraPatterns: [/CUSTOM-\d+/g] });
    const out = r([mkUserMsg('token CUSTOM-12345 here')]);
    const text = (out[0] as { content: { text: string }[] }).content[0].text;
    expect(text).toBe('token [redacted] here');
  });
});
