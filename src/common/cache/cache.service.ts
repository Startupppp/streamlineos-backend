import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

export const REDIS = "REDIS";

@Injectable()
export class CacheService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  private static readonly FILL_LEASE_SECONDS = 10;
  private static readonly FILL_WAIT_MS = 2_000;
  private static readonly FILL_POLL_MS = 50;

  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  async cached<T>(key: string, fetcher: () => Promise<T>, ttlSeconds = 300): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const request = this.loadOrFetch(key, fetcher, ttlSeconds);
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
    const version = await this.namespaceVersion(namespace);
    return this.cached(`${namespace}:v${version}:${key}`, fetcher, ttlSeconds);
  }

  async invalidateNamespace(namespace: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.incr(this.namespaceVersionKey(namespace));
    } catch {
      return;
    }
  }

  private async loadOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: number,
  ): Promise<T> {
    if (!this.redis) return fetcher();
    try {
      const hit = await this.redis.get<T>(key);
      if (hit !== null) return hit;
    } catch {
      return fetcher();
    }

    const leaseKey = `cache:fill-lease:${key}`;
    const leaseToken = randomUUID();
    let acquired: boolean;
    try {
      acquired = (await this.redis.set(leaseKey, leaseToken, {
        ex: CacheService.FILL_LEASE_SECONDS,
        nx: true,
      })) === "OK";
    } catch {
      return fetcher();
    }

    if (!acquired) {
      const deadline = Date.now() + CacheService.FILL_WAIT_MS;
      while (Date.now() < deadline) {
        await this.delay(CacheService.FILL_POLL_MS);
        try {
          const filled = await this.redis.get<T>(key);
          if (filled !== null) return filled;
        } catch {
          return fetcher();
        }
      }
      // Availability wins if a lease holder dies or takes longer than the wait
      // budget. The short lease still bounds duplicate work across instances.
      return fetcher();
    }

    try {
      const data = await fetcher();
      try {
        await this.redis.set(key, data, { ex: ttlSeconds });
      } catch {
        return data;
      }
      return data;
    } finally {
      try {
        await this.redis.eval<[string], number>(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          [leaseKey],
          [leaseToken],
        );
      } catch {
        // The lease expires on its own; never fail a request during cleanup.
      }
    }
  }

  private namespaceVersionKey(namespace: string): string {
    return `cache:namespace:${namespace}:version`;
  }

  private async namespaceVersion(namespace: string): Promise<number> {
    if (!this.redis) return 0;
    try {
      return (await this.redis.get<number>(this.namespaceVersionKey(namespace))) ?? 0;
    } catch {
      return 0;
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get<T>(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, value, { ex: ttlSeconds });
    } catch {
      return;
    }
  }

  async invalidate(key: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(key);
    } catch {
      return;
    }
  }

  async del(key: string): Promise<void> {
    return this.invalidate(key);
  }

}
