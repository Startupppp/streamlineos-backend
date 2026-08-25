import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
import { REDIS } from "../../common/cache/cache.service";
import { logger } from "../../common/logger/logger.service";

export type LeaseOutcome<T> = { ran: true; result: T } | { ran: false };

@Injectable()
export class CronLeaseService {
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  async withLease<T>(
    jobKey: string,
    windowSeconds: number,
    fn: () => Promise<T>,
  ): Promise<LeaseOutcome<T>> {
    if (!this.redis) {
      logger.warn(`[cron-lease] Redis unavailable; running ${jobKey} without dedup`);
      return { ran: true, result: await fn() };
    }

    const leaseKey = `cron:lease:${jobKey}`;
    const token = randomUUID();

    let acquired: boolean;
    try {
      acquired =
        (await this.redis.set(leaseKey, token, { ex: windowSeconds, nx: true })) === "OK";
    } catch {
      logger.warn(`[cron-lease] Redis error acquiring lease for ${jobKey}; running without dedup`);
      return { ran: true, result: await fn() };
    }

    if (!acquired) {
      logger.warn(`[cron-lease] ${jobKey} already running; skipping duplicate trigger`);
      return { ran: false };
    }

    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      try {
        await this.redis.eval<[string], number>(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          [leaseKey],
          [token],
        );
      } catch (err: unknown) {
        logger.warn(
          `[cron-lease] failed to release ${jobKey}; it expires in ${windowSeconds}s`,
          { cause: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }
}
