import { Inject, Injectable, Logger } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { withSpan } from "../observability/tracing";
import { CacheFiller } from "./cache-fill";
import { CacheRegionRouter } from "./cache-region-router";
import type { ExactCacheKey } from "./cache-keys";

export const REDIS = "REDIS";
export const REDIS_COMMAND_TIMEOUT = "REDIS_COMMAND_TIMEOUT";

/**
 * The cache's public surface: key naming, namespace generations, org scoping and
 * invalidation.
 *
 * Two collaborators carry the parts that are their own subject and are testable
 * without this class. `CacheFiller` (`cache-fill.ts`) owns everything about
 * turning a miss into a value once — single-flight, the distributed fill lease,
 * TTL jitter and the degraded-outage memo. `CacheRegionRouter`
 * (`cache-region-router.ts`) owns which Redis an org's entries live in and what
 * its keys are prefixed with. Both are constructed here and neither imports this
 * file, so the dependency runs one way and no file exists only to forward calls.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  private readonly fill: CacheFiller;
  private readonly region: CacheRegionRouter;

  private static readonly INVALIDATE_ATTEMPTS = 3;
  private static readonly INVALIDATE_BACKOFF_MS = 20;

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
  ) {
    this.fill = new CacheFiller((operation) => this.timedRedis(operation));
    this.region = new CacheRegionRouter(redis, commandTimeoutMs);
  }

  /** Dropped invalidations since boot. A non-zero value means stale entries may be serving. */
  get droppedInvalidationCount(): number {
    return this.droppedInvalidations;
  }

  /** Entries served from the degraded-path memo since boot. Non-zero means Redis was unreachable. */
  get outageMemoServedCount(): number {
    return this.fill.outageMemoServedCount;
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
    return this.fill.run(this.redis, key, fetcher, ttlSeconds);
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
    return this.fill.run(this.redis, `${namespace}:v${version}:${key}`, fetcher, ttlSeconds);
  }

  async cachedVersionedWithOutcome<T>(
    namespace: string,
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds = 300,
  ): Promise<{ value: T; cacheOutcome: "hit" | "miss" | "bypass" }> {
    const version = await this.namespaceVersionWithRedis(this.redis, namespace);
    return this.fill.runWithOutcome(this.redis, `${namespace}:v${version}:${key}`, fetcher, ttlSeconds);
  }

  async invalidateNamespace(namespace: string): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    await this.invalidateWithRetry("invalidateNamespace", namespace, () =>
      redis.incr(this.namespaceVersionKey(namespace)),
    );
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
    this.fill.drop(key);
    const redis = this.redis;
    if (!redis) return;
    await this.invalidateWithRetry("invalidate", key, () =>
      redis.del(key, this.fill.leaseKey(key)),
    );
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
    for (const key of keys) this.fill.drop(key);
    const redis = this.redis;
    if (!redis) return;
    const unique = [...new Set(keys.flatMap((key) => [key, this.fill.leaseKey(key)]))];
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

  async orgScopedKey(orgId: string, localKey: ExactCacheKey): Promise<string> {
    return this.region.scopedKey(orgId, localKey);
  }

  async cachedForOrg<T>(
    orgId: string,
    localKey: ExactCacheKey,
    fetcher: () => Promise<T>,
    baseTtl = 300,
  ): Promise<T> {
    const redis = await this.region.redisForOrg(orgId);
    const key = await this.region.scopedKey(orgId, localKey);
    return this.fill.run(redis, key, fetcher, baseTtl);
  }

  async cachedForOrgWith<T>(
    orgId: string,
    localKey: ExactCacheKey,
    fetcher: () => Promise<T>,
    ttlFn: (result: T) => number,
    maxTtl: number,
  ): Promise<T> {
    const redis = await this.region.redisForOrg(orgId);
    const key = await this.region.scopedKey(orgId, localKey);
    const bounded = (result: T): number =>
      Math.min(Math.max(this.fill.jitterTtl(ttlFn(result)), 1), maxTtl);
    return this.fill.run(redis, key, fetcher, bounded);
  }

  async cachedVersionedForOrg<T>(
    orgId: string,
    namespace: string,
    localKey: string,
    fetcher: () => Promise<T>,
    baseTtl = 300,
  ): Promise<T> {
    const redis = await this.region.redisForOrg(orgId);
    const ns = await this.region.scopedKey(orgId, namespace);
    const version = await this.namespaceVersionWithRedis(redis, ns);
    return this.fill.run(redis, `${ns}:v${version}:${localKey}`, fetcher, baseTtl);
  }

  async invalidateNamespaceForOrg(orgId: string, namespace: string): Promise<void> {
    const redis = await this.region.redisForOrg(orgId);
    const ns = await this.region.scopedKey(orgId, namespace);
    if (!redis) return;
    await this.invalidateWithRetry("invalidateNamespaceForOrg", ns, () =>
      redis.incr(this.namespaceVersionKey(ns)),
    );
  }

  async invalidateForOrg(orgId: string, localKey: ExactCacheKey): Promise<void> {
    const redis = await this.region.redisForOrg(orgId);
    const key = await this.region.scopedKey(orgId, localKey);
    this.fill.drop(key);
    if (!redis) return;
    await this.invalidateWithRetry("invalidateForOrg", key, () =>
      redis.del(key, this.fill.leaseKey(key)),
    );
  }

  async invalidateManyForOrg(
    orgId: string,
    localKeys: readonly ExactCacheKey[],
  ): Promise<void> {
    const redis = await this.region.redisForOrg(orgId);
    const scoped = await Promise.all(
      [...new Set(localKeys)].map((localKey) => this.region.scopedKey(orgId, localKey)),
    );
    for (const key of scoped) this.fill.drop(key);
    if (!redis) return;
    const unique = [...new Set(scoped.flatMap((key) => [key, this.fill.leaseKey(key)]))];
    for (let i = 0; i < unique.length; i += CacheService.INVALIDATE_KEY_CHUNK) {
      const chunk = unique.slice(i, i + CacheService.INVALIDATE_KEY_CHUNK);
      const [head, ...rest] = chunk;
      if (head === undefined) continue;
      await this.invalidateWithRetry(
        "invalidateManyForOrg",
        `${String(chunk.length)} keys`,
        () => redis.del(head, ...rest),
      );
    }
  }
}
