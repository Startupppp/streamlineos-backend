import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNotNull, lt, ne, sql } from "drizzle-orm";
import { emailOutbox, notificationDeliveries } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";

/**
 * SEC-009. Neither `email_outbox` nor `notification_deliveries` had any purge, so
 * both retained rendered message bodies indefinitely — including the payslip net-pay
 * figure (`email/templates/payroll.ts:18-21`) and deal values.
 *
 * Two horizons, decided 2026-08-11:
 *   - 90 days  — drop the rendered CONTENT, keep the row.
 *   - 13 months — drop the ROW.
 * Metadata outlives the body so a delivery dispute or a bounce history is still
 * answerable long after the content itself stops being worth the exposure.
 */
export const RETENTION_BODY_DAYS = 90;
export const RETENTION_RECORD_MONTHS = 13;

const BATCH_SIZE = 1000;
const MAX_BATCHES = 100;

export interface RetentionSweepResult {
  emailBodiesPurged: number;
  emailRecordsDeleted: number;
  deliveryBodiesPurged: number;
  deliveryRecordsDeleted: number;
  truncated: boolean;
}

@Injectable()
export class CronNotificationRetentionService {
  private readonly logger = new Logger(CronNotificationRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<RetentionSweepResult> {
    const now = Date.now();
    const bodyCutoff = new Date(now - RETENTION_BODY_DAYS * 86_400_000);
    const recordCutoff = new Date(now - RETENTION_RECORD_MONTHS * 30 * 86_400_000);

    const result: RetentionSweepResult = {
      emailBodiesPurged: 0,
      emailRecordsDeleted: 0,
      deliveryBodiesPurged: 0,
      deliveryRecordsDeleted: 0,
      truncated: false,
    };

    // email_outbox carries no tenant on any row (its RLS policy escapes on
    // organization_id IS NULL), so it sweeps globally without a tenant context.
    result.emailBodiesPurged = await this.batched((limit) =>
      this.db
        .update(emailOutbox)
        .set({ html: "", text: null })
        .where(
          sql`${emailOutbox.id} in (
            select id from ${emailOutbox}
            where ${emailOutbox.createdAt} < ${bodyCutoff} and ${emailOutbox.html} <> ''
            limit ${limit}
          )`,
        )
        .returning({ id: emailOutbox.id })
        .then((rows) => rows.length),
    );

    result.emailRecordsDeleted = await this.batched((limit) =>
      this.db
        .delete(emailOutbox)
        .where(
          sql`${emailOutbox.id} in (
            select id from ${emailOutbox}
            where ${emailOutbox.createdAt} < ${recordCutoff}
            limit ${limit}
          )`,
        )
        .returning({ id: emailOutbox.id })
        .then((rows) => rows.length),
    );

    // notification_deliveries enforces org_id = app.current_org_id(), so a global
    // sweep is denied 42501. Iterate tenants (CLAUDE.md §20).
    await forEachOrg(this.db, "notification-retention", async (tx, orgId) => {
      const purged = await tx
        .update(notificationDeliveries)
        .set({ metadata: null })
        .where(
          and(
            eq(notificationDeliveries.orgId, orgId),
            lt(notificationDeliveries.createdAt, bodyCutoff),
            isNotNull(notificationDeliveries.metadata),
          ),
        )
        .returning({ id: notificationDeliveries.id });
      result.deliveryBodiesPurged += purged.length;

      const deleted = await tx
        .delete(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.orgId, orgId),
            lt(notificationDeliveries.createdAt, recordCutoff),
          ),
        )
        .returning({ id: notificationDeliveries.id });
      result.deliveryRecordsDeleted += deleted.length;
    });

    this.logger.log(
      `RETENTION: email bodies ${result.emailBodiesPurged}, email rows ${result.emailRecordsDeleted}, ` +
        `delivery bodies ${result.deliveryBodiesPurged}, delivery rows ${result.deliveryRecordsDeleted}`,
    );
    return result;
  }

  /**
   * Deletes in bounded batches rather than one statement, so a backlog cannot hold
   * a lock across the whole table (§19). Stops at MAX_BATCHES and reports it —
   * a silent cap would read as "everything is purged" when it is not.
   */
  private async batched(run: (limit: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const affected = await run(BATCH_SIZE);
      total += affected;
      if (affected < BATCH_SIZE) return total;
    }
    this.logger.warn(
      `RETENTION: hit the ${MAX_BATCHES}-batch cap with rows still eligible — rerun the sweep`,
    );
    return total;
  }
}
