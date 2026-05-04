interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private map = new Map<K, CacheEntry<V>>();
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(opts: { capacity: number; ttlMs: number }) {
    this.capacity = opts.capacity;
    this.ttlMs = opts.ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  getOrCreate(key: K, lookup: (key: K) => V): V {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    const value = lookup(key);
    this.set(key, value);
    return value;
  }

  async getOrCreateAsync(key: K, lookup: (key: K) => Promise<V>): Promise<V> {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    const value = await lookup(key);
    this.set(key, value);
    return value;
  }
}
