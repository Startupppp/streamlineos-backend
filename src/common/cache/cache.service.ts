import { Inject, Injectable, Logger } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
import { withSpan } from "../observability/tracing";
import { getRegionRegistry, hasRegionRegistry } from "../region/region-registry";

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

  async cached<T>(key: string, fetcher: () => Promise<T>, ttlSeconds = 300): Promise<T> {
    return this.cachedWithRedis(this.redis, key, fetcher, ttlSeconds);
  }

  private async cachedWithRedis<T>(
    redis: Redis | null,
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: number | ((result: T) => number),
  ): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const request = this.loadOrFetch(redis, key, fetcher, ttlSeconds);
    this.inFlight.set(key, request);
    try {
      return await request;
    } finally {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
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

  private async loadOrFetch<T>(
    redis: Redis | null,
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: number | ((result: T) => number),
  ): Promise<T> {
    if (!redis) return fetcher();
    try {
      const hit = await this.timedRedis(() => redis.get<T>(key));
      if (hit !== null) return hit;
    } catch {
      return fetcher();
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
      return fetcher();
    }

    if (!acquired) {
      const deadline = Date.now() + CacheService.FILL_WAIT_MS;
      while (Date.now() < deadline) {
        await this.delay(CacheService.FILL_POLL_MS);
        try {
          const filled = await this.timedRedis(() => redis.get<T>(key));
          if (filled !== null) return filled;
        } catch {
          return fetcher();
        }
      }
      return fetcher();
    }

    try {
      const data = await fetcher();
      const ttl = typeof ttlSeconds === "function" ? ttlSeconds(data) : ttlSeconds;
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

  async get<T>(key: string): Promise<T | null> {
    const redis = this.redis;
    if (!redis) return null;
    try {
      return await this.timedRedis(() => redis.get<T>(key));
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    try {
      await this.timedRedis(() => redis.set(key, value, { ex: ttlSeconds }));
    } catch {
      return;
    }
  }

  async invalidate(key: string): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    await this.invalidateWithRetry("invalidate", key, () => redis.del(key));
  }

  async del(key: string): Promise<void> {
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

  async orgScopedKey(orgId: string, localKey: string): Promise<string> {
    const prefix = await this.cellPrefixForOrg(orgId);
    return prefix ? `${prefix}:${orgId}:${localKey}` : `${orgId}:${localKey}`;
  }

  async cachedForOrg<T>(
    orgId: string,
    localKey: string,
    fetcher: () => Promise<T>,
    baseTtl = 300,
  ): Promise<T> {
    const redis = await this.redisForOrg(orgId);
    const key = await this.orgScopedKey(orgId, localKey);
    return this.cachedWithRedis(redis, key, fetcher, this.applyJitter(baseTtl));
  }

  async cachedForOrgWith<T>(
    orgId: string,
    localKey: string,
    fetcher: () => Promise<T>,
    ttlFn: (result: T) => number,
    maxTtl: number,
  ): Promise<T> {
    const redis = await this.redisForOrg(orgId);
    const key = await this.orgScopedKey(orgId, localKey);
    const bounded = (result: T): number => Math.min(Math.max(ttlFn(result), 1), maxTtl);
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
    return this.cachedWithRedis(redis, `${ns}:v${version}:${localKey}`, fetcher, this.applyJitter(baseTtl));
  }

  async invalidateNamespaceForOrg(orgId: string, namespace: string): Promise<void> {
    const redis = await this.redisForOrg(orgId);
    const ns = await this.orgScopedKey(orgId, namespace);
    if (!redis) return;
    await this.invalidateWithRetry("invalidateNamespaceForOrg", ns, () =>
      redis.incr(this.namespaceVersionKey(ns)),
    );
  }

  async invalidateForOrg(orgId: string, localKey: string): Promise<void> {
    const redis = await this.redisForOrg(orgId);
    const prefix = await this.cellPrefixForOrg(orgId);
    const key = prefix ? `${prefix}:${orgId}:${localKey}` : `${orgId}:${localKey}`;
    if (!redis) return;
    await this.invalidateWithRetry("invalidateForOrg", key, () => redis.del(key));
  }

}
