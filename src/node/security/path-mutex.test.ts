import { describe, it, expect } from 'vitest';
import { PathMutex } from './path-mutex.js';

describe('PathMutex', () => {
  it('serializes concurrent acquires on the same path', async () => {
    const mutex = new PathMutex();
    const order: string[] = [];

    async function task(label: string, delay: number) {
      const release = await mutex.acquire('/tmp/x');
      order.push(`${label}-start`);
      await new Promise((r) => setTimeout(r, delay));
      order.push(`${label}-end`);
      release();
    }

    await Promise.all([task('a', 20), task('b', 10), task('c', 5)]);

    // All tasks must run to completion before the next starts — so ends
    // interleave only after their own starts. The critical property: no
    // `b-start` between `a-start` and `a-end`.
    expect(order).toEqual([
      'a-start',
      'a-end',
      'b-start',
      'b-end',
      'c-start',
      'c-end',
    ]);
  });

  it('does not serialize acquires on different paths', async () => {
    const mutex = new PathMutex();
    const started: string[] = [];
    const releaseA = await mutex.acquire('/tmp/a');
    // With a held, an acquire on a different path must resolve immediately.
    const acquireB = mutex.acquire('/tmp/b').then((release) => {
      started.push('b');
      release();
    });
    await acquireB;
    expect(started).toEqual(['b']);
    releaseA();
  });

  it('release is idempotent', async () => {
    const mutex = new PathMutex();
    const release = await mutex.acquire('/tmp/x');
    release();
    release(); // second call is a no-op
    // Next acquire succeeds without deadlock.
    const release2 = await mutex.acquire('/tmp/x');
    release2();
  });

  it('cleans up map entry when no waiters remain', async () => {
    const mutex = new PathMutex();
    const release = await mutex.acquire('/tmp/cleanup');
    release();
    // Give the microtask a chance to land
    await Promise.resolve();
    // @ts-expect-error — reading private field for test
    expect(mutex.chains.has('/tmp/cleanup')).toBe(false);
  });

  it('a throwing holder does not deadlock subsequent acquires', async () => {
    const mutex = new PathMutex();
    const release = await mutex.acquire('/tmp/err');
    try {
      throw new Error('inside critical section');
    } catch {
      // caller must still release in finally block
      release();
    }
    // Subsequent acquire succeeds
    const r2 = await mutex.acquire('/tmp/err');
    r2();
  });
});
