import { describe, it, expect } from 'vitest';
import { AsyncQueue } from './messages.js';

describe('AsyncQueue', () => {
  it('enqueue and tryDequeue work synchronously', () => {
    const q = new AsyncQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    expect(q.tryDequeue()).toBe(1);
    expect(q.tryDequeue()).toBe(2);
    expect(q.tryDequeue()).toBeUndefined();
  });

  it('tryDequeue returns undefined when empty', () => {
    const q = new AsyncQueue<string>();
    expect(q.tryDequeue()).toBeUndefined();
  });

  it('dequeue resolves immediately if item available', async () => {
    const q = new AsyncQueue<string>();
    q.enqueue('hello');
    const result = await q.dequeue();
    expect(result).toBe('hello');
  });

  it('dequeue waits for enqueue', async () => {
    const q = new AsyncQueue<number>();

    // Start dequeue before any item is enqueued
    const promise = q.dequeue();

    // Enqueue after a microtask
    setTimeout(() => q.enqueue(42), 10);

    const result = await promise;
    expect(result).toBe(42);
  });

  it('multiple waiters are resolved in order', async () => {
    const q = new AsyncQueue<number>();

    const p1 = q.dequeue();
    const p2 = q.dequeue();

    q.enqueue(1);
    q.enqueue(2);

    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
  });

  it('enqueue resolves waiter immediately instead of queueing', async () => {
    const q = new AsyncQueue<string>();

    const promise = q.dequeue();
    q.enqueue('direct');

    // The item should have gone directly to the waiter, not the queue
    expect(q.isEmpty()).toBe(true);
    expect(await promise).toBe('direct');
  });

  it('isEmpty returns true when empty', () => {
    const q = new AsyncQueue<number>();
    expect(q.isEmpty()).toBe(true);
  });

  it('isEmpty returns false when items exist', () => {
    const q = new AsyncQueue<number>();
    q.enqueue(1);
    expect(q.isEmpty()).toBe(false);
  });

  it('clear removes all items', () => {
    const q = new AsyncQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
    q.clear();
    expect(q.isEmpty()).toBe(true);
    expect(q.tryDequeue()).toBeUndefined();
  });

  it('clear rejects pending waiters', async () => {
    const q = new AsyncQueue<number>();

    // Create waiters that will be rejected on clear
    const p1 = q.dequeue().catch((e: Error) => e.message);
    const p2 = q.dequeue().catch((e: Error) => e.message);

    q.clear();

    // Pending waiters should be rejected
    expect(await p1).toBe('Queue cleared');
    expect(await p2).toBe('Queue cleared');

    // After clear, new enqueue should go to the queue, not old waiters
    q.enqueue(99);
    expect(q.tryDequeue()).toBe(99);
  });
});
