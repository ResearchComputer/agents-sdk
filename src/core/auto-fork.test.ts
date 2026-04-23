import { describe, it, expect } from 'vitest';
import { extractUserText } from './auto-fork.js';

describe('extractUserText', () => {
  it('returns the string when content is a plain string', () => {
    expect(extractUserText('hello world')).toBe('hello world');
  });

  it('returns the text part when content is an array containing text', () => {
    expect(
      extractUserText([
        { type: 'image', url: 'x.png' },
        { type: 'text', text: 'the text' },
      ]),
    ).toBe('the text');
  });

  it('returns undefined when content array has no text part', () => {
    expect(extractUserText([{ type: 'image', url: 'x.png' }])).toBeUndefined();
  });

  it('returns undefined for unexpected shapes', () => {
    expect(extractUserText(null)).toBeUndefined();
    expect(extractUserText(undefined)).toBeUndefined();
    expect(extractUserText(42)).toBeUndefined();
  });
});
