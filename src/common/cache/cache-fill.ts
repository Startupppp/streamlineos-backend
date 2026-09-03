import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

/**
 * Turning a miss into a value exactly once.
 *
 * This is the whole fill path and nothing else: in-process single-flight, the
 * distributed fill lease that keeps two nodes from racing the same key, the TTL
 * jitter that stops a cohort of keys expiring in lockstep, and the degraded-path
 * memo that bounds what a Redis outage costs the database. It reads and writes
 * Redis but owns no key naming, no namespace generation and no region routing —
 * `CacheService` composes those around it and hands this class a key that is
 * already final.
 *
 * The dependency runs one way: `CacheService` constructs a `CacheFiller`; nothing
 * here imports `CacheService`.
 */

/** How `CacheService` times and traces a single Redis round trip. */
export type TimedRedisOp = <T>(operation: () => Promise<T>) => Promise<T>;

export type TtlSpec<T> = number | ((result: T) => number);

export class CacheFiller {
  private static readonly FILL_LEASE_SECONDS = 10;
  private static readonly FILL_WAIT_MS = 2_000;
  private static readonly FILL_POLL_MS = 50;

  /**
   * What a Redis outage costs, and what it must not cost.
   *
   * Every degraded path here returns `fetcher()`. `inFlight` coalesces requests
   * that overlap in time and deletes on settle, so it is not a value memo:
   * serialized traffic went to the database on every request, on all 213 call
   * sites, for the whole outage. That is the stampede §6 forbids, arriving
   * exactly when the database is least able to absorb it.
   *
   * A degraded fill therefore keeps its settled promise in `inFlight` for this
   * window instead of deleting it. It is process-local, never shared, and it is
   * armed ONLY when Redis could not answer — the healthy path still deletes on
   * settle, because there Redis is the single source and an explicit
   * invalidation has to bite immediately.
   *
   * The window is one second against a smallest declared TTL of 30 s
   * (`CACHE_TTL.SHORT`), so it can never extend an entry's life beyond what the
   * same call site already accepts from the shared cache. Three rules keep
   * authorization correct: an authorization-scoped key is never retained at all
   * (see `AUTHZ_KEY_MARKERS`); a `null` is never retained, so a denial still
   * re-queries on the next request and a fresh grant takes effect immediately;
   * and an explicit `invalidate` drops the memo for that key at once, before
   * the `!redis` early return, so it bites during the outage too.
   *
   * `degradation/redis.spec.ts` pinned "no stale value served" when Redis is
   * dead. That invariant is kept where it was earned — on authorization — and
   * narrowed, rather than overruled, everywhere else: during an outage the
   * alternative is not a fresher answer, it is no cache at all and the whole
   * read volume on the database.
   */
  private static readonly OUTAGE_MEMO_MS = 1_000;
  private static readonly OUTAGE_MEMO_MAX_KEYS = 2_000;

  /**
   * Substrings, not prefixes: `cachedForOrg` prepends the tenant (and a region
   * cell prefix before that), so `access:perms:<user>:v<n>` arrives as
   * `<cell>:<org>:access:perms:...` and a prefix test would miss every one.
   *
   * Two authorization paths are already immune by construction and are listed
   * for the reader rather than relied on: `revoked:session:<id>` is read with a
   * raw `redis.get` in `JwtAuthGuard`, never through this fill path, and the
   * permission cache carries the access version IN its key, which is read from
   * the database when Redis is down — so a `bumpPermissionsVersion` produces a
   * different key and no memo can answer it.
   */
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
  ];

  private static isAuthorizationScoped(key: string): boolean {
    const lower = key.toLowerCase();
    return CacheFiller.AUTHZ_KEY_MARKERS.some((marker) => lower.includes(marker));
  }

  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly memoUntil = new Map<string, number>();
  private readonly degradedFills = new Set<string>();
  private outageMemoServed = 0;

  constructor(private readonly timedRedis: TimedRedisOp) {}

  /** Entries served from the degraded-path memo since boot. Non-zero means Redis was unreachable. */
  get outageMemoServedCount(): number {
    return this.outageMemoServed;
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

  /**
   * The one place a coalesced promise's element type is asserted, and the only
   * assertion in this file.
   *
   * `inFlight` is heterogeneous by construction: it coalesces every cache key in
   * the process and each key's element type is fixed by whichever caller filled
   * it first. TypeScript cannot carry that key-to-type relation — it is
   * dependent typing — and there is nothing to validate against at runtime
   * either, because the value is whatever the domain fetcher returned. So the
   * assertion is irreducible. What is not irreducible is having several of them:
   * both coalescing returns below used to force the type independently, which
   * is three places to keep a shared invariant instead of one.
   *
   * The invariant, stated once here: `run<T>` is the only writer and the only
   * reader of `inFlight`, and it stores exactly the promise returned by the
   * `fetcher: () => Promise<T>` it was handed. A key therefore carries one
   * element type for the life of its entry, and a caller that finds an entry
   * under its own key is looking at its own T.
   */
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

  /**
   * TTL jitter applies to every fill path, not two of six.
   *
   * `applyJitter` was wired into `cachedForOrg` and `cachedVersionedForOrg`
   * only — 30 of 213 call sites — so `cached` (88) and `cachedVersioned` (95),
   * the path §6 names as canonical, expired in lockstep. TTLs come from five
   * shared constants, so a set of keys filled in the same second expired in the
   * same second and re-stampeded together. Applying it where the TTL is
   * resolved for the write is the one place no caller can bypass.
   *
   * A caller-supplied TTL function jitters inside its own bound instead, so a
   * declared `maxTtl` still holds — `CacheService.cachedForOrgWith` calls this
   * directly for exactly that reason.
   */
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

  /**
   * Expiry by sweep rather than a timer per key: an outage across a
   * high-cardinality key space would otherwise arm thousands of timers to save
   * one map delete, and each would hold a settled value alive until it fired.
   *
   * The window is a constant, so insertion order IS expiry order and the sweep
   * stops at the first entry still live — amortised O(1) per retained fill, not
   * O(n). The cap is the hard bound on what an outage can hold: values here can
   * be large, so an unswept map is a memory leak wearing a cache's clothes.
   */
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
      const hit = await this.timedRedis(() => redis.get<T>(key));
      if (hit !== null) return hit;
    } catch {
      return this.degraded(key, fetcher);
    }

    const leaseKey = `cache:fill-lease:${key}`;
    const leaseToken = randomUUID();
    let acquired: boolean;
    try {
      acquired = (await this.timedRedis(() => redis.set(leaseKey, leaseToken, {
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
      /**
       * A `null` is never written. The read above treats `null` as a miss by
       * design (negative caching is deliberately absent so a denial cannot
       * outlive the grant that ends it), so writing one bills a round trip for
       * a value that can never be read — and, worse, makes every waiter below
       * poll a key that will never satisfy them.
       */
      if (data === null) return data;
      try {
        await this.timedRedis(() => redis.set(key, data, { ex: ttl }));
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

  /**
   * Waiting on somebody else's fill.
   *
   * The loop used to poll only the value key, so it could not tell "the leader
   * has not written yet" from "the leader has finished and the answer is null" —
   * and because a null is never cached, the second case never resolves. Every
   * loser then paid the full `FILL_WAIT_MS`, 40 Redis GETs, AND the database
   * query: for a hot key whose value is legitimately null the lease was worse
   * than no lease at all. The same blindness held a waiter for the full window
   * when the leader crashed.
   *
   * Checking the lease answers both: the lease is released on the leader's
   * `finally` and expires on its own, so its absence means no fill is coming and
   * the waiter should stop waiting. The extra GET is only paid on a poll that
   * found no value, and it replaces up to 39 pointless ones.
   */
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
        const filled = await this.timedRedis(() => redis.get<T>(key));
        if (filled !== null) return filled;
        const leaseHolder = await this.timedRedis(() => redis.get<string>(leaseKey));
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
