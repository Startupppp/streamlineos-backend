import { Injectable, Logger } from "@nestjs/common";
import { CronLeaseService } from "../cron/cron-lease.service";
import { expiredPartitions, NOTIFICATION_RETENTION_POLICY, type RetainedTable } from "./notification-retention-policy";
import { PartitionMaintenanceService } from "./partition-maintenance.service";

export interface RetentionRunResult {
  partitionsDetached: number;
  partitionsDropped: number;
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
      },
    };

    for (const table of Object.keys(NOTIFICATION_RETENTION_POLICY) as RetainedTable[]) {
      const partitions = expiredPartitions(table, now);
      const { detached, dropped } = await this.maintenance.sweepParent(table, partitions);
      result.tables[table].detached += detached;
      result.tables[table].dropped += dropped;
      result.partitionsDetached += detached;
      result.partitionsDropped += dropped;
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
}
