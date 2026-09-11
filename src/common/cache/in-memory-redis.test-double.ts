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

  constructor(private readonly deafToInvalidation = false) {}

  get<T>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    return Promise.resolve(value === undefined ? null : (value as T));
  }

  set(key: string, value: unknown, options?: { ex?: number; nx?: boolean }): Promise<string | null> {
    if (options?.nx === true && this.store.has(key)) return Promise.resolve(null);
    this.store.set(key, value);
    return Promise.resolve("OK");
  }

  incr(key: string): Promise<number> {
    const current = Number(this.store.get(key) ?? 0);
    if (this.deafToInvalidation) return Promise.resolve(current);
    this.store.set(key, current + 1);
    return Promise.resolve(current + 1);
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }

  eval(script: string, keys: string[], args: string[]): Promise<number> {
    if (this.store.get(keys[0]) !== args[0]) return Promise.resolve(0);
    if (script.includes('redis.call("set"') && keys[1] !== undefined) {
      this.store.set(keys[1], JSON.parse(args[1] ?? "null"));
      return Promise.resolve(1);
    }
    this.store.delete(keys[0]);
    return Promise.resolve(1);
  }
}
