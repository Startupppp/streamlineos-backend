/**
 * The Redis surface `CacheService` actually uses, in memory.
 *
 * `CacheService` takes its client through `@Inject(REDIS)`, so a read-after-write
 * test needs no integration harness — it needs these five methods. Asserting on a
 * mocked `invalidateNamespace` call list instead proves only that a line was
 * reached, which is what c19-01 and c19-04 were raised to stop.
 *
 * `deafToInvalidation` drops the generation bump so the namespace never moves.
 * That is the negative control: without it, a cache that silently never caches
 * would satisfy every read-after-write assertion vacuously. Prefer it to
 * temporarily breaking the production file — five programs share this working
 * tree and one of them will stage the broken byte.
 */
export class InMemoryRedis {
  private readonly store = new Map<string, unknown>();
  private readonly expiresAt = new Map<string, number>();
  private clockMs: number;

  constructor(
    private readonly deafToInvalidation = false,
    private readonly options: { honourExpiry?: boolean } = {},
  ) {
    this.clockMs = 0;
  }

  /** Advances the double's clock so a TTL written with `ex` can actually elapse. */
  advanceSeconds(seconds: number): void {
    this.clockMs += seconds * 1000;
    if (this.options.honourExpiry !== true) return;
    for (const [key, expiry] of this.expiresAt)
      if (expiry <= this.clockMs) {
        this.store.delete(key);
        this.expiresAt.delete(key);
      }
  }

  /** Remaining TTL in seconds, or null when the key carries none. */
  ttlSeconds(key: string): number | null {
    const expiry = this.expiresAt.get(key);
    if (expiry === undefined) return null;
    return (expiry - this.clockMs) / 1000;
  }

  keys(): string[] {
    return [...this.store.keys()];
  }

  get<T>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    return Promise.resolve(value === undefined ? null : (value as T));
  }

  set(key: string, value: unknown, options?: { ex?: number; nx?: boolean }): Promise<string | null> {
    if (options?.nx === true && this.store.has(key)) return Promise.resolve(null);
    this.store.set(key, value);
    if (options?.ex === undefined) this.expiresAt.delete(key);
    else this.expiresAt.set(key, this.clockMs + options.ex * 1000);
    return Promise.resolve("OK");
  }

  incr(key: string): Promise<number> {
    const current = Number(this.store.get(key) ?? 0);
    if (this.deafToInvalidation) return Promise.resolve(current);
    this.store.set(key, current + 1);
    return Promise.resolve(current + 1);
  }

  del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      this.expiresAt.delete(key);
      if (this.store.delete(key)) removed += 1;
    }
    return Promise.resolve(removed);
  }

  eval(script: string, keys: string[], args: string[]): Promise<number> {
    if (this.store.get(keys[0]) !== args[0]) return Promise.resolve(0);
    if (script.includes('redis.call("set"') && keys[1] !== undefined) {
      this.store.set(keys[1], JSON.parse(args[1] ?? "null"));
      const ex = Number(args[2]);
      if (Number.isFinite(ex)) this.expiresAt.set(keys[1], this.clockMs + ex * 1000);
      return Promise.resolve(1);
    }
    this.store.delete(keys[0]);
    return Promise.resolve(1);
  }
}
