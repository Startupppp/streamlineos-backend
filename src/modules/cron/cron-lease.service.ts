import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
import { REDIS } from "../../common/cache/cache.service";
import { logger } from "../../common/logger/logger.service";
import { PROCESS_CELL_ID } from "../../common/cell-resources/cell-id";
import { shutdownState } from "../../health/shutdown-state";

export type LeaseOutcome<T> = { ran: true; result: T } | { ran: false };

export const HEARTBEAT_KEY_PREFIX = "cron:heartbeat:";
export const LAST_ERROR_KEY_PREFIX = "cron:last-error:";
const HEARTBEAT_TTL_SECONDS = 7 * 24 * 3600;

@Injectable()
export class CronLeaseService {
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  /**
   * A draining process takes no new lease.
   *
   * The lease is the only thing standing between two workers and a duplicated
   * batch, and a sweep started seconds before the process exits is either
   * abandoned mid-batch or finished by a pool that is already closing. Refusing
   * here leaves the work claimable: the lease is never taken, so the next tick —
   * on this replica or another — picks it up whole. That is a handoff, not a
   * loss, and it is why `stopAccepting` precedes waiting for quiescence.
   */
  async withLease<T>(
    jobKey: string,
    windowSeconds: number,
    fn: () => Promise<T>,
  ): Promise<LeaseOutcome<T>> {
    if (shutdownState.isDraining()) {
      logger.warn(
        `[cron-lease] ${PROCESS_CELL_ID}:${jobKey} refused — process is draining; the next tick resumes it`,
      );
      return { ran: false };
    }

    if (!this.redis) {
      logger.warn(`[cron-lease] Redis unavailable; running ${PROCESS_CELL_ID}:${jobKey} without dedup`);
      return { ran: true, result: await fn() };
    }

    const leaseKey = `cron:lease:${PROCESS_CELL_ID}:${jobKey}`;
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
      logger.warn(`[cron-lease] ${PROCESS_CELL_ID}:${jobKey} already running; skipping duplicate trigger`);
      return { ran: false };
    }

    try {
      const result = await fn();
      await this.writeHeartbeat(jobKey);
      return { ran: true, result };
    } catch (err: unknown) {
      await this.writeFailureRecord(jobKey, err);
      throw err;
    } finally {
      try {
        await this.redis.eval<[string], number>(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          [leaseKey],
          [token],
        );
      } catch (err: unknown) {
        logger.warn(
          `[cron-lease] failed to release ${PROCESS_CELL_ID}:${jobKey}; it expires in ${windowSeconds}s`,
          { cause: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }

  private async writeHeartbeat(jobKey: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(`${HEARTBEAT_KEY_PREFIX}${jobKey}`, new Date().toISOString(), {
        ex: HEARTBEAT_TTL_SECONDS,
      });
    } catch (err: unknown) {
      logger.warn(`[cron-lease] failed to write heartbeat for ${jobKey}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async writeFailureRecord(jobKey: string, err: unknown): Promise<void> {
    if (!this.redis) return;
    try {
      const record = {
        error: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      };
      await this.redis.set(`${LAST_ERROR_KEY_PREFIX}${jobKey}`, JSON.stringify(record), {
        ex: HEARTBEAT_TTL_SECONDS,
      });
    } catch (writeErr: unknown) {
      logger.warn(`[cron-lease] failed to write failure record for ${jobKey}`, {
        cause: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
  }
}
