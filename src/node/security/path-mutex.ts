/**
 * Per-path async mutex. Serializes writes to the same absolute path across
 * concurrent tool invocations so parallel Edit/Write calls cannot race and
 * clobber each other.
 *
 * Internally uses a `Map<absPath, Promise>` chain: each acquire awaits the
 * previous release for the same path. `release()` is idempotent; calling
 * it twice is a no-op. The map entry is cleaned up when the last waiter
 * releases so long-running hosts don't accumulate stale chains.
 *
 * Usage:
 *
 *   const release = await pathMutex.acquire(absPath);
 *   try {
 *     // read-modify-write
 *   } finally {
 *     release();
 *   }
 */
export class PathMutex {
  private chains = new Map<string, Promise<void>>();

  async acquire(absPath: string): Promise<() => void> {
    const prev = this.chains.get(absPath) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    this.chains.set(absPath, chained);
    await prev;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      // If no later acquire has replaced our entry, drop the map key so a
      // long-running host doesn't accumulate stale chains.
      if (this.chains.get(absPath) === chained) {
        this.chains.delete(absPath);
      }
    };
  }
}

/** Module-level singleton used by all built-in tools. */
export const pathMutex = new PathMutex();
