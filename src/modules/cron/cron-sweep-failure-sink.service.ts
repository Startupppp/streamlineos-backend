import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { REDIS } from "../../common/cache/cache.service";
import { logger } from "../../common/logger/logger.service";
import { registerSweepFailureSink, type SweepPartialFailure } from "../../common/tenant";
import { LAST_ERROR_KEY_PREFIX } from "./cron-lease.service";
import { retentionJobForSweep } from "./retention-schedule";

const RECORD_TTL_SECONDS = 7 * 24 * 3600;
/** Enough to name the tenants without letting one bad night write an unbounded value. */
const MAX_ORG_IDS_RECORDED = 50;

/**
 * Turns a per-tenant sweep failure into a durable, alertable record.
 *
 * `forEachOrg` isolates a failing organisation so the rest of the sweep still drains,
 * and then returned the count. Nothing read it: the route answered 200 and
 * `CronLeaseService` wrote a success heartbeat, so a tenant whose retention sweep threw
 * on every tick was indistinguishable from one with nothing to delete. This writes the
 * same `cron:last-error:<key>` record the lease writes on a total failure, so the
 * dead-man alert and the runbook cover partial failure with no second mechanism.
 *
 * The heartbeat is still written: the sweep did run, and suppressing it would report a
 * partial failure as a dead job. Staleness and partial failure are different faults and
 * are signalled separately.
 */
@Injectable()
export class CronSweepFailureSinkService implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  onModuleInit(): void {
    registerSweepFailureSink((event) => this.record(event));
  }

  onModuleDestroy(): void {
    registerSweepFailureSink(null);
  }

  /** The retention job key when the sweep is one, so the alert joins to its heartbeat. */
  static recordKey(sweep: string): string {
    return retentionJobForSweep(sweep)?.jobKey ?? sweep;
  }

  async record(event: SweepPartialFailure): Promise<void> {
    const key = `${LAST_ERROR_KEY_PREFIX}${CronSweepFailureSinkService.recordKey(event.sweep)}`;
    const payload = {
      error:
        `${String(event.failed)} of ${String(event.organizations)} organisation(s) failed ` +
        `during ${event.sweep}`,
      ts: event.at,
      sweep: event.sweep,
      organizations: event.organizations,
      succeeded: event.succeeded,
      failed: event.failed,
      failedOrgIds: event.failedOrgIds.slice(0, MAX_ORG_IDS_RECORDED),
      partial: true,
    };

    logger.error(`[${event.sweep}] partial failure`, payload);

    if (!this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(payload), { ex: RECORD_TTL_SECONDS });
    } catch (err: unknown) {
      logger.warn(`[${event.sweep}] failed to write the partial-failure record`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
