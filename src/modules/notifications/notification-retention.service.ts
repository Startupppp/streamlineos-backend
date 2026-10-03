import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { CronLeaseService } from "../cron/cron-lease.service";
import { expiredPartitions, NOTIFICATION_RETENTION_POLICY, type RetainedTable } from "./notification-retention-policy";
import { PartitionMaintenanceService } from "./partition-maintenance.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

export interface RetentionRunResult {
  partitionsDetached: number;
  partitionsDropped: number;
  partitionsHeld: number;
  tables: Record<RetainedTable, { detached: number; dropped: number }>;
}

const LEASE_KEY = "notification-retention-detach";
const LEASE_WINDOW_SECONDS = 3600;

@Injectable()
export class NotificationRetentionService {
  private readonly logger = new Logger(NotificationRetentionService.name);

  constructor(
    private readonly maintenance: PartitionMaintenanceService,
    private readonly lease: CronLeaseService,
    @Inject(DRIZZLE) private readonly db: Db,
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
      partitionsHeld: 0,
      tables: {
        notifications: { detached: 0, dropped: 0 },
        chat_messages: { detached: 0, dropped: 0 },
      },
    };

    for (const table of Object.keys(NOTIFICATION_RETENTION_POLICY) as RetainedTable[]) {
      const partitions = expiredPartitions(table, now);
      const { safe, held } = await this.filterHeldPartitions(partitions);
      result.partitionsHeld += held;
      const { detached, dropped } = await this.maintenance.sweepParent(table, safe);
      result.tables[table].detached += detached;
      result.tables[table].dropped += dropped;
      result.partitionsDetached += detached;
      result.partitionsDropped += dropped;
    }

    if (result.partitionsDetached > 0 || result.partitionsDropped > 0 || result.partitionsHeld > 0) {
      this.logger.log(
        `RETENTION_DETACH: ${result.partitionsDetached} detached, ${result.partitionsDropped} dropped, ` +
          `${result.partitionsHeld} held — ` +
          Object.entries(result.tables)
            .map(([t, r]) => `${t}(${r.detached}/${r.dropped})`)
            .join(", "),
      );
    }

    return result;
  }

  private async filterHeldPartitions(
    partitions: string[],
  ): Promise<{ safe: string[]; held: number }> {
    const safe: string[] = [];
    let held = 0;
    for (const partition of partitions) {
      if (await this.partitionHasHeldData(partition)) {
        this.logger.warn(
          `RETENTION_DETACH: skipping ${partition} — active legal hold protects data in this partition`,
        );
        held += 1;
      } else {
        safe.push(partition);
      }
    }
    return { safe, held };
  }

  private async partitionHasHeldData(partition: string): Promise<boolean> {
    try {
      const [row] = await this.db.execute(
        sql`SELECT EXISTS (
          SELECT 1 FROM ${sql.identifier(partition)} p
          WHERE p.org_id IN (
            SELECT org_id FROM hr_legal_holds
            WHERE status = 'active' AND deleted_at IS NULL
            UNION ALL
            SELECT org_id FROM organization_legal_holds
            WHERE released_at IS NULL
          )
          LIMIT 1
        ) AS has_held_data`,
      );
      return row?.["has_held_data"] === true;
    } catch {
      return false;
    }
  }
}
