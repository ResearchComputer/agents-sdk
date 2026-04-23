/**
 * A simple async queue for swarm agent communication (mailbox pattern).
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<{ resolve: (item: T) => void; reject: (err: Error) => void }> = [];

  /**
   * Add an item to the queue. If a waiter exists, resolve it immediately.
   */
  enqueue(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
    } else {
      this.items.push(item);
    }
  }

  /**
   * Non-blocking dequeue. Returns undefined if queue is empty.
   */
  tryDequeue(): T | undefined {
    return this.items.shift();
  }

  /**
   * Async dequeue. Resolves when an item is available.
   * Rejects if the queue is cleared while waiting.
   */
  dequeue(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    return new Promise<T>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Returns true if the queue has no items.
   */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Clear all items and reject pending waiters.
   */
  clear(): void {
    this.items = [];
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter.reject(new Error('Queue cleared'));
    }
  }
}
