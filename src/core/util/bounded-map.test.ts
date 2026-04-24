import { describe, it, expect } from 'vitest';
import { BoundedMap } from './bounded-map.js';

describe('BoundedMap', () => {
  it('stores up to maxSize entries', () => {
    const m = new BoundedMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    expect(m.size).toBe(3);
    expect(m.get('a')).toBe(1);
  });

  it('evicts the oldest entry when full', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    expect(m.size).toBe(2);
    expect(m.has('a')).toBe(false);
    expect(m.get('b')).toBe(2);
    expect(m.get('c')).toBe(3);
  });

  it('re-inserting an existing key updates value but does NOT trigger eviction', () => {
    // FIFO semantics: re-setting an existing key does not count as a new
    // insertion, so no eviction fires. But insertion order is preserved —
    // a later `set` of a new key will still evict the original oldest.
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 99); // hit path — no eviction triggered
    expect(m.size).toBe(2);
    expect(m.get('a')).toBe(99);
    expect(m.get('b')).toBe(2);
  });

  it('FIFO eviction (not LRU): re-setting a key does not refresh its age', () => {
    // If this were an LRU, the re-set of 'a' would move it to the newest
    // position and 'b' would be evicted next. BoundedMap is simple FIFO,
    // so 'a' remains the oldest and is evicted on the next new insertion.
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 99);
    m.set('c', 3);
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(true);
    expect(m.has('c')).toBe(true);
  });

  it('rejects non-positive maxSize', () => {
    expect(() => new BoundedMap(0)).toThrow(/maxSize/);
    expect(() => new BoundedMap(-1)).toThrow(/maxSize/);
  });

  it('inherits Map methods (delete, clear, entries)', () => {
    const m = new BoundedMap<string, number>(5);
    m.set('a', 1);
    m.set('b', 2);
    m.delete('a');
    expect(m.size).toBe(1);
    const keys = Array.from(m.keys());
    expect(keys).toEqual(['b']);
    m.clear();
    expect(m.size).toBe(0);
  });
});
