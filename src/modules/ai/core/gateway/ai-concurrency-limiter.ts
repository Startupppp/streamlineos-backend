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

  /**
   * A Redis outage falls back to the in-process counter; it does NOT wave the
   * cap through.
   *
   * The old catch returned `true`, so the exact moment the shared counter became
   * unreadable — a Redis incident, which is also when the provider is most
   * likely to be struggling — every pod let unlimited concurrent paid AI calls
   * through. The `localCounts` path three lines below was already the right
   * answer and was simply never reached: per-pod it is weaker than the shared
   * counter and stronger than no cap at all, which is the whole point of a
   * fallback.
   */
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
        this.logger.warn(
          `Redis concurrency check unavailable for org ${orgId} — falling back to the in-process counter`,
          { err: err instanceof Error ? err.message : String(err) },
        );
        return this.acquireLocally(orgId);
      }
    }
    return this.acquireLocally(orgId);
  }

  /**
   * Releases against whichever store the matching `acquire` used. An
   * outstanding local count means at least one acquisition took the fallback
   * path, and slots are fungible within a store, so draining the local counter
   * first keeps both counters balanced in aggregate. Decrementing Redis for an
   * acquisition Redis never saw would drive the shared counter negative and
   * silently widen the cap for everyone.
   */
  release(orgId: string): void {
    const local = this.localCounts.get(orgId) ?? 0;
    if (local > 0) {
      if (local === 1) this.localCounts.delete(orgId);
      else this.localCounts.set(orgId, local - 1);
      return;
    }
    if (this.redis) void this.redis.decr(redisKey(orgId)).catch(() => undefined);
  }

  private acquireLocally(orgId: string): boolean {
    const local = this.localCounts.get(orgId) ?? 0;
    if (local >= AI_CONCURRENCY_CAP) return false;
    this.localCounts.set(orgId, local + 1);
    return true;
  }
}
