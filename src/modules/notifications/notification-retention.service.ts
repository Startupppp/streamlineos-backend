import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CronLeaseService } from "../cron/cron-lease.service";
import { expiredPartitions, NOTIFICATION_RETENTION_POLICY, type RetainedTable } from "./notification-retention-policy";

export interface RetentionRunResult {
  partitionsDetached: number;
  partitionsDropped: number;
  tables: Record<RetainedTable, { detached: number; dropped: number }>;
}

const LEASE_KEY = "notification-retention-detach";
const LEASE_WINDOW_SECONDS = 3600;

/**
 * C21-05 — Detach-not-delete retention sweep.
 *
 * Removes old data by DETACH PARTITION CONCURRENTLY + DROP TABLE IF EXISTS. This
 * approach holds no row locks and takes no exclusive lock on the parent table — the
 * detach is concurrent and the drop is on an already-detached table. A bulk DELETE
 * on a table of tens of billions of rows is a multi-hour operation that holds a
 * shared lock and blocks autovacuum; detach is O(1) in catalog metadata.
 *
 * The sweep is idempotent: DETACH IF EXISTS and DROP TABLE IF EXISTS are both
 * no-ops when the partition is absent, so a replay after a partial run does not
 * fail.
 *
 * GATED ON C21-04: the actual DETACH calls are no-ops until c21-04 creates the
 * monthly partitions. The policy and the mechanism are complete. Once the
 * partitions exist the sweep removes eligible months automatically on its next run.
 *
 * The sweep cannot run inside a tenant transaction (DETACH CONCURRENTLY is
 * disallowed inside a transaction block). It runs as raw DDL on the connection
 * pool's default role with no tenant GUC — these tables are global DDL objects,
 * not tenant data rows. The lock timeout guards against an extended DDL wait.
 */
@Injectable()
export class NotificationRetentionService {
  private readonly logger = new Logger(NotificationRetentionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly lease: CronLeaseService,
  ) {}

  async sweep(now = new Date()): Promise<RetentionRunResult | null> {
    const outcome = await this.lease.withLease(LEASE_KEY, LEASE_WINDOW_SECONDS, () =>
      this.run(now),
    );
    return outcome.ran ? outcome.result : null;
  }

  private async run(now: Date): Promise<RetentionRunResult> {
    const result: RetentionRunResult = {
      partitionsDetached: 0,
      partitionsDropped: 0,
      tables: {
        notifications: { detached: 0, dropped: 0 },
        chat_messages: { detached: 0, dropped: 0 },
        notification_outbox: { detached: 0, dropped: 0 },
      },
    };

    for (const table of Object.keys(NOTIFICATION_RETENTION_POLICY) as RetainedTable[]) {
      const partitions = expiredPartitions(table, now);
      for (const partition of partitions) {
        const { detached, dropped } = await this.detachAndDrop(table, partition);
        result.tables[table].detached += detached;
        result.tables[table].dropped += dropped;
        result.partitionsDetached += detached;
        result.partitionsDropped += dropped;
      }
    }

    if (result.partitionsDetached > 0 || result.partitionsDropped > 0) {
      this.logger.log(
        `RETENTION_DETACH: ${result.partitionsDetached} detached, ${result.partitionsDropped} dropped — ` +
          Object.entries(result.tables)
            .map(([t, r]) => `${t}(${r.detached}/${r.dropped})`)
            .join(", "),
      );
    }

    return result;
  }

  /**
   * Issues DETACH PARTITION CONCURRENTLY then DROP TABLE IF EXISTS.
   *
   * DETACH PARTITION CONCURRENTLY requires Postgres ≥ 14 and cannot run inside a
   * transaction block. `db.execute` on Neon runs on a session from the pool with
   * no ambient transaction, so this is safe as long as the caller does not wrap it.
   *
   * `lock_timeout` prevents a long catalog lock wait from stalling the sweep; the
   * retry happens on the next scheduled run.
   */
  private async detachAndDrop(
    parentTable: string,
    partition: string,
  ): Promise<{ detached: number; dropped: number }> {
    let detached = 0;
    let dropped = 0;

    try {
      await this.db.execute(sql`SET lock_timeout = '5s'`);
      await this.db.execute(
        sql`ALTER TABLE IF EXISTS ${sql.raw(parentTable)} DETACH PARTITION IF EXISTS ${sql.raw(partition)} CONCURRENTLY`,
      );
      detached = 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("does not exist") || msg.includes("lock_timeout")) {
        this.logger.debug(`RETENTION_DETACH: ${partition} skipped — ${msg}`);
        return { detached: 0, dropped: 0 };
      }
      this.logger.warn(`RETENTION_DETACH: detach of ${partition} failed — ${msg}`);
      return { detached: 0, dropped: 0 };
    }

    try {
      await this.db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(partition)}`);
      dropped = 1;
      this.logger.log(`RETENTION_DETACH: dropped partition ${partition}`);
    } catch (err) {
      this.logger.warn(
        `RETENTION_DETACH: detached ${partition} but drop failed — ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    return { detached, dropped };
  }
}
