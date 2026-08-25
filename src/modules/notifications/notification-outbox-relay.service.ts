import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { notificationOutbox } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { isNotificationEventKey } from "./notification-events.catalog";

const BATCH_SIZE = 50;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;

export interface OutboxRelayResult {
  claimed: number;
  processed: number;
  retried: number;
  dead: number;
}

/**
 * PIPE-001. Drains `notification_outbox` into the existing dispatch pipeline.
 *
 * At-least-once by construction: a row is leased, processed, then marked. If the
 * process dies mid-flight the lease expires and another pass reclaims it. A replay
 * cannot produce a second notification because the row's own `dedupeKey` is passed
 * down as the delivery idempotency discriminator, so the retry rebuilds the same
 * `notification_deliveries.idempotency_key` and the unique index refuses it. Do not
 * drop that argument: the time-bucket fallback is absent for the 9 events that set
 * `dedupeWindowSeconds: 0` — mentions, DMs, invites — and they would double-deliver.
 *
 * Runs per tenant via `forEachOrg`: `notification_outbox` enforces
 * `org_id = app.current_org_id()`, so a global sweep is denied `42501` (§20).
 */
@Injectable()
export class NotificationOutboxRelayService {
  private readonly logger = new Logger(NotificationOutboxRelayService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async flush(): Promise<OutboxRelayResult> {
    const result: OutboxRelayResult = { claimed: 0, processed: 0, retried: 0, dead: 0 };
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);

    const claimed: Array<typeof notificationOutbox.$inferSelect> = [];

    await forEachOrg(this.db, "notification-outbox-relay", async (tx, orgId) => {
      const remaining = BATCH_SIZE - claimed.length;
      if (remaining <= 0) return;

      // One statement, FOR UPDATE SKIP LOCKED: two relays never fight over the same
      // row, and neither blocks on the other (SCH-016's lesson, applied here from the
      // start rather than retrofitted).
      const rows = await tx
        .update(notificationOutbox)
        .set({ state: "IN_FLIGHT", leaseExpiresAt: leaseUntil })
        .where(
          sql`${notificationOutbox.id} in (
            select id from ${notificationOutbox}
            where org_id = ${orgId}
              and (
                state = 'PENDING'
                or (state = 'IN_FLIGHT' and lease_expires_at < ${now.toISOString()}::timestamptz)
              )
            order by id
            limit ${remaining}
            for update skip locked
          )`,
        )
        .returning();
      claimed.push(...rows);
    });

    result.claimed = claimed.length;
    if (claimed.length === 0) return result;

    for (const row of claimed) {
      try {
        if (!isNotificationEventKey(row.eventKey))
          throw new Error(`event key is not in the catalog: ${row.eventKey}`);

        await this.dispatch.emitNow({
          eventKey: row.eventKey,
          orgId: row.orgId,
          dedupeKey: row.dedupeKey,
          actorUserId: row.actorUserId,
          notifySelf: row.notifySelf,
          targetUserIds: row.targetUserIds,
          entityType: row.entityType ?? undefined,
          entityId: row.entityId ?? undefined,
          title: row.title ?? undefined,
          message: row.message ?? undefined,
          link: row.link ?? undefined,
          variables: row.variables,
          metadata: row.metadata ?? undefined,
        });

        await this.mark(row, { state: "PROCESSED", processedAt: new Date() });
        result.processed += 1;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = row.attemptCount + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        // Never swallowed: a deferred failure that logs nothing is how the last
        // notification outage stayed invisible for the life of the product (§20).
        this.logger.error(
          `outbox row ${row.id} (${row.eventKey}, org ${row.orgId}) failed on attempt ${attempts}: ${message}`,
        );
        await this.mark(row, {
          state: dead ? "DEAD" : "PENDING",
          attemptCount: attempts,
          lastError: message,
          leaseExpiresAt: null,
        });
        if (dead) result.dead += 1;
        else result.retried += 1;
      }
    }

    return result;
  }

  /** One tenant transaction for the row's own org — not a sweep looking for it. */
  private mark(
    row: typeof notificationOutbox.$inferSelect,
    patch: Partial<typeof notificationOutbox.$inferInsert>,
  ): Promise<void> {
    return runInNewTenantTransaction(this.db, row.orgId, async (tx) => {
      await tx.update(notificationOutbox).set(patch).where(eq(notificationOutbox.id, row.id));
    });
  }
}
