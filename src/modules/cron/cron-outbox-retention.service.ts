import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { outboxEvents, inboxRecords } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";

export const OUTBOX_RETENTION_DAYS = 30;

const BATCH_SIZE = 1000;
const MAX_BATCHES = 50;

export interface OutboxRetentionResult {
  outboxEventsDeleted: number;
  inboxRecordsDeleted: number;
  truncated: boolean;
}

@Injectable()
export class CronOutboxRetentionService {
  private readonly logger = new Logger(CronOutboxRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<OutboxRetentionResult> {
    const cutoff = new Date(Date.now() - OUTBOX_RETENTION_DAYS * 86_400_000);
    const result: OutboxRetentionResult = {
      outboxEventsDeleted: 0,
      inboxRecordsDeleted: 0,
      truncated: false,
    };

    await forEachOrg(this.db, "outbox-retention", async (tx, orgId) => {
      const { outboxDeleted, inboxDeleted, truncated } = await this.sweepOrg(tx, orgId, cutoff);
      result.outboxEventsDeleted += outboxDeleted;
      result.inboxRecordsDeleted += inboxDeleted;
      if (truncated) result.truncated = true;
    });

    this.logger.log(
      `[outbox-retention] outbox_events deleted=${result.outboxEventsDeleted} ` +
        `inbox_records deleted=${result.inboxRecordsDeleted} truncated=${result.truncated} cutoff=${cutoff.toISOString()}`,
    );
    return result;
  }

  private async sweepOrg(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
  ): Promise<{ outboxDeleted: number; inboxDeleted: number; truncated: boolean }> {
    const outboxBatch = await this.batchedOrgDelete((limit) =>
      tx
        .delete(outboxEvents)
        .where(
          sql`${outboxEvents.outboxEventId} IN (
            SELECT outbox_event_id FROM outbox_events
            WHERE org_id = ${orgId}
              AND delivery_state IN ('DELIVERED', 'DEAD', 'SUPPRESSED')
              AND occurred_at < ${cutoff}
            LIMIT ${limit}
          )`,
        )
        .returning({ id: outboxEvents.outboxEventId })
        .then((rows) => rows.length),
    );

    const inboxBatch = await this.batchedOrgDelete((limit) =>
      tx
        .delete(inboxRecords)
        .where(
          sql`${inboxRecords.inboxRecordId} IN (
            SELECT inbox_record_id FROM inbox_records
            WHERE org_id = ${orgId}
              AND processed_at IS NOT NULL
              AND processed_at < ${cutoff}
            LIMIT ${limit}
          )`,
        )
        .returning({ id: inboxRecords.inboxRecordId })
        .then((rows) => rows.length),
    );

    return {
      outboxDeleted: outboxBatch.count,
      inboxDeleted: inboxBatch.count,
      truncated: outboxBatch.truncated || inboxBatch.truncated,
    };
  }

  private async batchedOrgDelete(
    run: (limit: number) => Promise<number>,
  ): Promise<{ count: number; truncated: boolean }> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const affected = await run(BATCH_SIZE);
      total += affected;
      if (affected < BATCH_SIZE) return { count: total, truncated: false };
    }
    this.logger.warn(
      `[outbox-retention] hit the ${MAX_BATCHES}-batch cap with rows still eligible — rerun the sweep`,
    );
    return { count: total, truncated: true };
  }
}
