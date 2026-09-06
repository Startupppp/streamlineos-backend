import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
import { CacheCircuitBreaker } from "./cache-circuit-breaker";

export type TimedRedisOp = <T>(operation: () => Promise<T>) => Promise<T>;

export type TtlSpec<T> = number | ((result: T) => number);

export class CacheFiller {
  private static readonly FILL_LEASE_SECONDS = 10;
  private static readonly FILL_WAIT_MS = 2_000;
  private static readonly FILL_POLL_MS = 50;

  /**
   * During an outage the degraded path keeps its settled promise in `inFlight`
   * for OUTAGE_MEMO_MS instead of deleting it, bounding the DB stampede.
   * Authorization-scoped keys are never retained (see AUTHZ_KEY_MARKERS);
   * null is never retained so denials re-query immediately.
   */
  private static readonly OUTAGE_MEMO_MS = 1_000;
  private static readonly OUTAGE_MEMO_MAX_KEYS = 2_000;

  static readonly AUTHZ_KEY_MARKERS: readonly string[] = [
    "user:session:",
    "membership:",
    "access:",
    "rbac:",
    "mfa:",
    "revoked:",
    "perms:",
    "permission",
    "entitlement",
    "kb:acc-spaces:",
  ];

  private static isAuthorizationScoped(key: string): boolean {
    const lower = key.toLowerCase();
    return CacheFiller.AUTHZ_KEY_MARKERS.some((marker) => lower.includes(marker));
  }

  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly memoUntil = new Map<string, number>();
  private readonly degradedFills = new Set<string>();
  private outageMemoServed = 0;
  private readonly breaker: CacheCircuitBreaker;

  constructor(private readonly timedRedis: TimedRedisOp) {
    this.breaker = new CacheCircuitBreaker(timedRedis);
  }

  leaseKey(key: string): string {
    return `cache:fill-lease:${key}`;
  }

  /** Entries served from the degraded-path memo since boot. Non-zero means Redis was unreachable. */
  get outageMemoServedCount(): number {
    return this.outageMemoServed;
  }

  /** True while the circuit breaker is open (Redis commands are being skipped). */
  get isCircuitOpen(): boolean {
    return this.breaker.isOpen;
  }

  /**
   * Drops any in-flight promise and degraded memo for a key. An explicit
   * invalidation calls this BEFORE it reaches Redis, so it bites during an
   * outage too.
   */
  drop(key: string): void {
    this.inFlight.delete(key);
    this.memoUntil.delete(key);
    this.degradedFills.delete(key);
  }

  /** Single place where the heterogeneous inFlight map's element type is asserted. run<T> is the only writer so the cast is safe by construction. */
  private coalesced<T>(inFlight: Promise<unknown>): Promise<T> {
    return inFlight as Promise<T>;
  }

  async run<T>(
    redis: Redis | null,
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: TtlSpec<T>,
  ): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      const memoisedUntil = this.memoUntil.get(key);
      if (memoisedUntil === undefined) return this.coalesced<T>(existing);
      if (memoisedUntil > Date.now()) {
        this.outageMemoServed += 1;
        return this.coalesced<T>(existing);
      }
      this.drop(key);
    }

    const request = this.loadOrFetch(redis, key, fetcher, ttlSeconds);
    this.inFlight.set(key, request);
    try {
      const value = await request;
      this.retainOrRelease(key, request, value);
      return value;
    } catch (error) {
      if (this.inFlight.get(key) === request) this.drop(key);
      throw error;
    }
  }

  jitterTtl(baseTtl: number): number {
    return Math.round(baseTtl * (0.85 + Math.random() * 0.3));
  }

  private retainOrRelease(key: string, request: Promise<unknown>, value: unknown): void {
    if (this.inFlight.get(key) !== request) return;
    const degraded = this.degradedFills.delete(key);
    if (
      !degraded ||
      value === null ||
      CacheFiller.OUTAGE_MEMO_MS <= 0 ||
      CacheFiller.isAuthorizationScoped(key)
    ) {
      this.inFlight.delete(key);
      this.memoUntil.delete(key);
      return;
    }
    this.memoUntil.set(key, Date.now() + CacheFiller.OUTAGE_MEMO_MS);
    this.sweepMemos();
  }

  private sweepMemos(): void {
    const now = Date.now();
    for (const [key, until] of this.memoUntil) {
      if (until > now) break;
      this.drop(key);
    }
    for (const key of this.memoUntil.keys()) {
      if (this.memoUntil.size <= CacheFiller.OUTAGE_MEMO_MAX_KEYS) break;
      this.drop(key);
    }
  }

  private degraded<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    this.degradedFills.add(key);
    return fetcher();
  }

  private async loadOrFetch<T>(
    redis: Redis | null,
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: TtlSpec<T>,
  ): Promise<T> {
    if (!redis) return this.degraded(key, fetcher);
    try {
      const hit = await this.breaker.execute(() => redis.get<T>(key));
      if (hit !== null) return hit;
    } catch {
      return this.degraded(key, fetcher);
    }

    const leaseKey = this.leaseKey(key);
    const leaseToken = randomUUID();
    let acquired: boolean;
    try {
      acquired = (await this.breaker.execute(() => redis.set(leaseKey, leaseToken, {
        ex: CacheFiller.FILL_LEASE_SECONDS,
        nx: true,
      }))) === "OK";
    } catch {
      return this.degraded(key, fetcher);
    }

    if (!acquired) return this.awaitFill(redis, key, leaseKey, fetcher);

    try {
      const data = await fetcher();
      const ttl = this.resolveTtl(data, ttlSeconds);
      if (data === null) return data;
      const serialized = JSON.stringify(data);
      if (serialized === undefined) return data;
      try {
        await this.timedRedis(() => redis.eval<[string, string, string], number>(
          'if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[2], ARGV[2], "EX", ARGV[3]); return 1 else return 0 end',
          [leaseKey, key],
          [leaseToken, serialized, String(ttl)],
        ));
      } catch {
        return data;
      }
      return data;
    } finally {
      try {
        await this.timedRedis(() => redis.eval<[string], number>(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          [leaseKey],
          [leaseToken],
        ));
      } catch {
      }
    }
  }

  private async awaitFill<T>(
    redis: Redis,
    key: string,
    leaseKey: string,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + CacheFiller.FILL_WAIT_MS;
    while (Date.now() < deadline) {
      await this.delay(CacheFiller.FILL_POLL_MS);
      try {
        const filled = await this.breaker.execute(() => redis.get<T>(key));
        if (filled !== null) return filled;
        const leaseHolder = await this.breaker.execute(() => redis.get<string>(leaseKey));
        if (leaseHolder === null) return fetcher();
      } catch {
        return this.degraded(key, fetcher);
      }
    }
    return fetcher();
  }

  private resolveTtl<T>(data: T, ttlSeconds: TtlSpec<T>): number {
    if (typeof ttlSeconds === "function") return Math.max(1, Math.round(ttlSeconds(data)));
    return Math.max(1, this.jitterTtl(ttlSeconds));
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
