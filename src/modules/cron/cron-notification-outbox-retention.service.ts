import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { notificationOutbox } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";

export const NOTIFICATION_OUTBOX_RETENTION_DAYS = 30;

/**
 * A DEAD row is not spent work, it is the evidence that a notification somebody was
 * owed will never be delivered — the same class of record `alert-dead-notification-outbox.mjs`
 * pages on. Purging it on the PROCESSED schedule made the retention sweep and the
 * DLQ watcher answer to different clocks, and a dead-letter investigation that starts
 * after the sweep finds nothing to investigate. DEAD rows are still bounded, just on a
 * horizon far past any alert or postmortem window.
 */
export const NOTIFICATION_OUTBOX_DEAD_RETENTION_DAYS = 180;

const BATCH_SIZE = 500;
const MAX_BATCHES = 50;

export interface NotificationOutboxRetentionResult {
  organizationsScanned: number;
  rowsDeleted: number;
  truncated: boolean;
}

@Injectable()
export class CronNotificationOutboxRetentionService {
  private readonly logger = new Logger(CronNotificationOutboxRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<NotificationOutboxRetentionResult> {
    const cutoff = new Date(Date.now() - NOTIFICATION_OUTBOX_RETENTION_DAYS * 86_400_000);
    const deadCutoff = new Date(
      Date.now() - NOTIFICATION_OUTBOX_DEAD_RETENTION_DAYS * 86_400_000,
    );
    const result: NotificationOutboxRetentionResult = {
      organizationsScanned: 0,
      rowsDeleted: 0,
      truncated: false,
    };

    const forEachResult = await forEachOrg(this.db, "notification-outbox-retention", async (tx, orgId) => {
      const { deleted, truncated } = await this.sweepOrg(tx, orgId, cutoff, deadCutoff);
      result.rowsDeleted += deleted;
      if (truncated) result.truncated = true;
    });

    result.organizationsScanned = forEachResult.organizations;

    this.logger.log(
      `[notification-outbox-retention] orgs=${result.organizationsScanned} ` +
        `deleted=${result.rowsDeleted} truncated=${result.truncated} cutoff=${cutoff.toISOString()} ` +
        `deadCutoff=${deadCutoff.toISOString()}`,
    );
    return result;
  }

  private async sweepOrg(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
    deadCutoff: Date,
  ): Promise<{ deleted: number; truncated: boolean }> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const rows = await tx
        .delete(notificationOutbox)
        .where(
          sql`${notificationOutbox.id} IN (
            SELECT id FROM notification_outbox
            WHERE org_id = ${orgId}
              AND state IN ('PROCESSED', 'DEAD')
              AND created_at < (CASE WHEN state = 'DEAD' THEN ${deadCutoff.toISOString()}::timestamptz ELSE ${cutoff.toISOString()}::timestamptz END)
            LIMIT ${BATCH_SIZE}
          )`,
        )
        .returning({ id: notificationOutbox.id });

      total += rows.length;
      if (rows.length < BATCH_SIZE) return { deleted: total, truncated: false };
    }
    this.logger.warn(
      `[notification-outbox-retention] org ${orgId} hit the ${MAX_BATCHES}-batch cap — rerun the sweep`,
    );
    return { deleted: total, truncated: true };
  }
}
