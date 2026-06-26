import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "@upstash/redis";

export const REDIS = "REDIS";

@Injectable()
export class CacheService {
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  async cached<T>(key: string, fetcher: () => Promise<T>, ttlSeconds = 300): Promise<T> {
    if (!this.redis) return fetcher();
    try {
      const hit = await this.redis.get<T>(key);
      if (hit !== null) return hit;
    } catch {
      return fetcher();
    }
    const data = await fetcher();
    try {
      await this.redis.set(key, data, { ex: ttlSeconds });
    } catch {
      return data;
    }
    return data;
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

  async invalidatePattern(pattern: string): Promise<void> {
    if (!this.redis) return;
    try {
      let cursor: string | number = 0;
      const keys: string[] = [];
      do {
        const [next, batch]: [string | number, string[]] = await this.redis.scan(cursor, { match: pattern, count: 100 });
        cursor = next;
        keys.push(...batch);
      } while (Number(cursor) !== 0);
      if (keys.length) await this.redis.del(...keys);
    } catch {
      return;
    }
  }
}
