import { Inject, Injectable, Logger } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
import { withSpan } from "../observability/tracing";
import { getRegionRegistry, hasRegionRegistry } from "../region/region-registry";
import type { ExactCacheKey } from "./cache-keys";

export const REDIS = "REDIS";
export const REDIS_COMMAND_TIMEOUT = "REDIS_COMMAND_TIMEOUT";

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly regionalRedis = new Map<string, Redis>();

  private static readonly FILL_LEASE_SECONDS = 10;
  private static readonly FILL_WAIT_MS = 2_000;
  private static readonly FILL_POLL_MS = 50;

  private static readonly INVALIDATE_ATTEMPTS = 3;
  private static readonly INVALIDATE_BACKOFF_MS = 20;

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
    return CacheService.AUTHZ_KEY_MARKERS.some((marker) => lower.includes(marker));
  }

  private readonly memoUntil = new Map<string, number>();
  private readonly degradedFills = new Set<string>();
  private outageMemoServed = 0;

  /**
   * A read that fails on a Redis error degrades to the database and is correct.
   * An *invalidation* that fails leaves a stale entry serving, so it is the one
   * operation that must not be dropped on the first error. Failures are retried,
   * and a final failure is an error with a stable marker rather than a warning,
   * because a silently swallowed invalidation makes the next outage invisible.
   */
  private static readonly DROPPED_MARKER = "cache.invalidation.dropped";

  private droppedInvalidations = 0;

  constructor(
    @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(REDIS_COMMAND_TIMEOUT) private readonly commandTimeoutMs = 3_000,
  ) {}

  /** Dropped invalidations since boot. A non-zero value means stale entries may be serving. */
  get droppedInvalidationCount(): number {
    return this.droppedInvalidations;
  }

  private async invalidateWithRetry(
    label: string,
    target: string,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= CacheService.INVALIDATE_ATTEMPTS; attempt++) {
      try {
        await this.timedRedis(operation);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < CacheService.INVALIDATE_ATTEMPTS)
          await this.delay(CacheService.INVALIDATE_BACKOFF_MS * attempt);
      }
    }
    this.droppedInvalidations++;
    this.logger.error(
      `${CacheService.DROPPED_MARKER} ${label} target=${target} attempts=${String(CacheService.INVALIDATE_ATTEMPTS)}`,
      lastError,
    );
  }

  async cached<T>(key: ExactCacheKey, fetcher: () => Promise<T>, ttlSeconds = 300): Promise<T> {
    return this.cachedWithRedis(this.redis, key, fetcher, ttlSeconds);
  }

  private async cachedWithRedis<T>(
    redis: Redis | null,
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: number | ((result: T) => number),
  ): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      const memoisedUntil = this.memoUntil.get(key);
      if (memoisedUntil === undefined) return existing as Promise<T>;
      if (memoisedUntil > Date.now()) {
        this.outageMemoServed += 1;
        return existing as Promise<T>;
      }
      this.dropInFlight(key);
    }

    const request = this.loadOrFetch(redis, key, fetcher, ttlSeconds);
    this.inFlight.set(key, request);
    try {
      const value = await request;
      this.retainOrRelease(key, request, value);
      return value;
    } catch (error) {
      if (this.inFlight.get(key) === request) this.dropInFlight(key);
      throw error;
    }
  }

  /** Entries served from the degraded-path memo since boot. Non-zero means Redis was unreachable. */
  get outageMemoServedCount(): number {
    return this.outageMemoServed;
  }

  private dropInFlight(key: string): void {
    this.inFlight.delete(key);
    this.memoUntil.delete(key);
    this.degradedFills.delete(key);
  }

  private retainOrRelease(key: string, request: Promise<unknown>, value: unknown): void {
    if (this.inFlight.get(key) !== request) return;
    const degraded = this.degradedFills.delete(key);
    if (
      !degraded ||
      value === null ||
      CacheService.OUTAGE_MEMO_MS <= 0 ||
      CacheService.isAuthorizationScoped(key)
    ) {
      this.inFlight.delete(key);
      this.memoUntil.delete(key);
      return;
    }
    this.memoUntil.set(key, Date.now() + CacheService.OUTAGE_MEMO_MS);
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
      this.dropInFlight(key);
    }
    for (const key of this.memoUntil.keys()) {
      if (this.memoUntil.size <= CacheService.OUTAGE_MEMO_MAX_KEYS) break;
      this.dropInFlight(key);
    }
  }

  /**
   * Stores entries behind a namespace generation. Invalidating the namespace is
   * an O(1) counter bump; old generations expire naturally and never need SCAN.
   */
  async cachedVersioned<T>(
    namespace: string,
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds = 300,
  ): Promise<T> {
    const version = await this.namespaceVersionWithRedis(this.redis, namespace);
    return this.cachedWithRedis(this.redis, `${namespace}:v${version}:${key}`, fetcher, ttlSeconds);
  }

  async invalidateNamespace(namespace: string): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    await this.invalidateWithRetry("invalidateNamespace", namespace, () =>
      redis.incr(this.namespaceVersionKey(namespace)),
    );
  }

  private degraded<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    this.degradedFills.add(key);
    return fetcher();
  }

  private async loadOrFetch<T>(
    redis: Redis | null,
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: number | ((result: T) => number),
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
        ex: CacheService.FILL_LEASE_SECONDS,
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
    const deadline = Date.now() + CacheService.FILL_WAIT_MS;
    while (Date.now() < deadline) {
      await this.delay(CacheService.FILL_POLL_MS);
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

  /**
   * TTL jitter applies to every fill path, not two of six.
   *
   * `applyJitter` was wired into `cachedForOrg` and `cachedVersionedForOrg`
   * only — 30 of 213 call sites — so `cached` (88) and `cachedVersioned` (95),
   * the path §6 names as canonical, expired in lockstep. TTLs come from five
   * shared constants, so a set of keys filled in the same second expired in the
   * same second and re-stampeded together. Applying it here, where the TTL is
   * resolved for the write, is the one place no caller can bypass.
   *
   * A caller-supplied TTL function jitters inside its own bound instead, so a
   * declared `maxTtl` still holds.
   */
  private resolveTtl<T>(data: T, ttlSeconds: number | ((result: T) => number)): number {
    if (typeof ttlSeconds === "function") return Math.max(1, Math.round(ttlSeconds(data)));
    return Math.max(1, this.applyJitter(ttlSeconds));
  }

  private namespaceVersionKey(namespace: string): string {
    return `cache:namespace:${namespace}:version`;
  }

  private async namespaceVersionWithRedis(redis: Redis | null, namespace: string): Promise<number> {
    if (!redis) return 0;
    try {
      return (await this.timedRedis(() => redis.get<number>(this.namespaceVersionKey(namespace)))) ?? 0;
    } catch {
      return 0;
    }
  }

  private timedRedis<T>(operation: () => Promise<T>): Promise<T> {
    return withSpan(
      "cache.roundtrip",
      () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Redis command timed out after ${this.commandTimeoutMs}ms`)),
            this.commandTimeoutMs,
          );
        });
        return Promise.race([operation(), deadline]).finally(() => clearTimeout(timer));
      },
      { attributes: { seam: "cache.roundtrip" } },
    );
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async get<T>(key: ExactCacheKey): Promise<T | null> {
    const redis = this.redis;
    if (!redis) return null;
    try {
      return await this.timedRedis(() => redis.get<T>(key));
    } catch {
      return null;
    }
  }

  async set(key: ExactCacheKey, value: unknown, ttlSeconds: number): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    try {
      await this.timedRedis(() => redis.set(key, value, { ex: ttlSeconds }));
    } catch {
      return;
    }
  }

  async invalidate(key: ExactCacheKey): Promise<void> {
    this.dropInFlight(key);
    const redis = this.redis;
    if (!redis) return;
    await this.invalidateWithRetry("invalidate", key, () => redis.del(key));
  }

  /**
   * One `DEL` for many keys instead of one round trip per key.
   *
   * `await Promise.all(users.map((u) => cache.invalidate(userSession(u.id))))`
   * reads as batched and is not: it issues one Redis command per user, all
   * concurrently against a single Upstash connection. Measured call sites before
   * this existed — `rbac/role-member` and `rbac/role-permission` at `.limit(500)`,
   * and `access/entitlements` at `.limit(10000)` — so one module toggle could fan
   * out to ten thousand commands.
   *
   * `DEL` is variadic, so the same work is `ceil(n / INVALIDATE_KEY_CHUNK)`
   * commands. The chunk exists because the Upstash REST transport puts the whole
   * command in one request body, so an unbounded key list becomes an unbounded
   * payload; 256 keys is well inside that limit and keeps a single failed chunk
   * from dropping every invalidation in the batch.
   *
   * Duplicates are collapsed first: the caller's list is usually derived from
   * rows, and `DEL k k` bills twice for one deletion.
   */
  private static readonly INVALIDATE_KEY_CHUNK = 256;

  async invalidateMany(keys: readonly ExactCacheKey[]): Promise<void> {
    for (const key of keys) this.dropInFlight(key);
    const redis = this.redis;
    if (!redis) return;
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += CacheService.INVALIDATE_KEY_CHUNK) {
      const chunk = unique.slice(i, i + CacheService.INVALIDATE_KEY_CHUNK);
      const [head, ...rest] = chunk;
      if (head === undefined) continue;
      await this.invalidateWithRetry(
        "invalidateMany",
        `${String(chunk.length)} keys`,
        () => redis.del(head, ...rest),
      );
    }
  }

  /**
   * The generation-counter half of the same problem: `invalidateNamespace` is an
   * `INCR`, which cannot be folded into a `DEL`, so a per-user namespace bust
   * stayed one round trip per user even after `invalidateMany`. A pipeline sends
   * the whole chunk in one request.
   */
  async invalidateNamespaceMany(namespaces: readonly string[]): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    const unique = [...new Set(namespaces)];
    for (let i = 0; i < unique.length; i += CacheService.INVALIDATE_KEY_CHUNK) {
      const chunk = unique.slice(i, i + CacheService.INVALIDATE_KEY_CHUNK);
      if (chunk.length === 0) continue;
      await this.invalidateWithRetry(
        "invalidateNamespaceMany",
        `${String(chunk.length)} namespaces`,
        () => {
          const pipeline = redis.pipeline();
          for (const ns of chunk) pipeline.incr(this.namespaceVersionKey(ns));
          return pipeline.exec();
        },
      );
    }
  }

  async del(key: ExactCacheKey): Promise<void> {
    return this.invalidate(key);
  }

  private applyJitter(baseTtl: number): number {
    return Math.round(baseTtl * (0.85 + Math.random() * 0.3));
  }

  private async cellPrefixForOrg(orgId: string): Promise<string | null> {
    if (!hasRegionRegistry()) return null;
    try {
      return await getRegionRegistry().cacheKeyPrefixForOrg(orgId);
    } catch {
      return null;
    }
  }

  private async redisForOrg(orgId: string): Promise<Redis | null> {
    if (!hasRegionRegistry()) return this.redis;
    try {
      const config = await getRegionRegistry().cacheConfigForOrg(orgId);
      if (!config.upstashUrl || !config.upstashToken) return this.redis;
      const existing = this.regionalRedis.get(config.upstashUrl);
      if (existing) return existing;
      const client = new Redis({
        url: config.upstashUrl,
        token: config.upstashToken,
        signal: () => AbortSignal.timeout(this.commandTimeoutMs),
        retry: { retries: 0, backoff: () => 0 },
      });
      this.regionalRedis.set(config.upstashUrl, client);
      return client;
    } catch {
      return this.redis;
    }
  }

  async orgScopedKey(orgId: string, localKey: ExactCacheKey): Promise<string> {
    const prefix = await this.cellPrefixForOrg(orgId);
    return prefix ? `${prefix}:${orgId}:${localKey}` : `${orgId}:${localKey}`;
  }

  async cachedForOrg<T>(
    orgId: string,
    localKey: ExactCacheKey,
    fetcher: () => Promise<T>,
    baseTtl = 300,
  ): Promise<T> {
    const redis = await this.redisForOrg(orgId);
    const key = await this.orgScopedKey(orgId, localKey);
    return this.cachedWithRedis(redis, key, fetcher, baseTtl);
  }

  async cachedForOrgWith<T>(
    orgId: string,
    localKey: ExactCacheKey,
    fetcher: () => Promise<T>,
    ttlFn: (result: T) => number,
    maxTtl: number,
  ): Promise<T> {
    const redis = await this.redisForOrg(orgId);
    const key = await this.orgScopedKey(orgId, localKey);
    const bounded = (result: T): number =>
      Math.min(Math.max(this.applyJitter(ttlFn(result)), 1), maxTtl);
    return this.cachedWithRedis(redis, key, fetcher, bounded);
  }

  async cachedVersionedForOrg<T>(
    orgId: string,
    namespace: string,
    localKey: string,
    fetcher: () => Promise<T>,
    baseTtl = 300,
  ): Promise<T> {
    const redis = await this.redisForOrg(orgId);
    const ns = await this.orgScopedKey(orgId, namespace);
    const version = await this.namespaceVersionWithRedis(redis, ns);
    return this.cachedWithRedis(redis, `${ns}:v${version}:${localKey}`, fetcher, baseTtl);
  }

  async invalidateNamespaceForOrg(orgId: string, namespace: string): Promise<void> {
    const redis = await this.redisForOrg(orgId);
    const ns = await this.orgScopedKey(orgId, namespace);
    if (!redis) return;
    await this.invalidateWithRetry("invalidateNamespaceForOrg", ns, () =>
      redis.incr(this.namespaceVersionKey(ns)),
    );
  }

  async invalidateForOrg(orgId: string, localKey: ExactCacheKey): Promise<void> {
    const redis = await this.redisForOrg(orgId);
    const prefix = await this.cellPrefixForOrg(orgId);
    const key = prefix ? `${prefix}:${orgId}:${localKey}` : `${orgId}:${localKey}`;
    this.dropInFlight(key);
    if (!redis) return;
    await this.invalidateWithRetry("invalidateForOrg", key, () => redis.del(key));
  }

}
