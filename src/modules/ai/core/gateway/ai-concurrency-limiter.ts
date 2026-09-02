import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { REDIS } from "../../../../common/cache/cache.service";

export const AI_CONCURRENCY_CAP = 20;
const COUNTER_TTL_SECONDS = 120;

function redisKey(orgId: string): string {
  return `ai:inflight:${orgId}`;
}

@Injectable()
export class AiConcurrencyLimiter {
  private readonly logger = new Logger(AiConcurrencyLimiter.name);
  private readonly localCounts = new Map<string, number>();

  constructor(
    @Optional() @Inject(REDIS) private readonly redis: Redis | null = null,
  ) {}

  async acquire(orgId: string): Promise<boolean> {
    if (this.redis) {
      try {
        const key = redisKey(orgId);
        const count = await this.redis.incr(key);
        if (count === 1) void this.redis.expire(key, COUNTER_TTL_SECONDS).catch(() => undefined);
        if (count > AI_CONCURRENCY_CAP) {
          void this.redis.decr(key).catch(() => undefined);
          return false;
        }
        return true;
      } catch (err) {
        this.logger.warn(`Redis concurrency check unavailable for org ${orgId} — failing open`, {
          err: err instanceof Error ? err.message : String(err),
        });
        return true;
      }
    }
    const local = this.localCounts.get(orgId) ?? 0;
    if (local >= AI_CONCURRENCY_CAP) return false;
    this.localCounts.set(orgId, local + 1);
    return true;
  }

  release(orgId: string): void {
    if (this.redis) {
      void this.redis.decr(redisKey(orgId)).catch(() => undefined);
      return;
    }
    const local = this.localCounts.get(orgId) ?? 1;
    if (local <= 1) this.localCounts.delete(orgId);
    else this.localCounts.set(orgId, local - 1);
  }
}
