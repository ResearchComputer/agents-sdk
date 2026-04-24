/**
 * A Map subclass with a maximum size. When full, inserting a new key evicts
 * the oldest entry (insertion order — the entry returned first by
 * `Map.prototype.keys()`). Re-inserting an existing key does not evict and
 * does not change its eviction order. Intended for caches where
 * unbounded growth is unsafe (long-running hosts embedding the SDK).
 *
 * This is a simple FIFO, not a true LRU — access order isn't tracked
 * because the target caches (glob regex, schema) don't benefit enough
 * from LRU to justify re-ordering on every `get()`.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) {
    super();
    if (maxSize <= 0) {
      throw new Error(`BoundedMap maxSize must be > 0 (got ${maxSize})`);
    }
  }

  override set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.maxSize) {
      // Evict the oldest entry (insertion order).
      const oldest = this.keys().next();
      if (!oldest.done) {
        this.delete(oldest.value);
      }
    }
    return super.set(key, value);
  }
}
