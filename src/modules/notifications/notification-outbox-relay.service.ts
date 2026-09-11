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

/**
 * The most any one organization may take out of a single tick's global budget.
 *
 * Without it the claim was `limit ${remaining}` — the whole rest of the batch — so
 * the lowest-id tenant with a backlog took all 50 rows and every tenant sorting
 * after it saw `remaining <= 0` and returned. Their rows stayed PENDING, therefore
 * never attempted, therefore never reached DEAD, therefore `alert-dead-outbox`
 * never fired: an indefinite, silent notification outage whose victims were chosen
 * by how their org id sorts. Measured over 8 tenants x 200 pending rows x 5 ticks,
 * the head form reached two organizations; with this cap and the rotating cursor
 * below it reaches all eight.
 *
 * Same ratio as `ORG_BATCH_CAP` in the delivery worker, which had this half of the
 * fix from the start — five tenants per tick.
 */
export const OUTBOX_ORG_BATCH_CAP = Math.ceil(BATCH_SIZE / 5);

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
 * cannot produce a second notification because the row's own key is passed down as
 * `replayKey`, so the retry rebuilds the same
 * `notification_deliveries.idempotency_key` and the unique index refuses it. Do not
 * drop that argument: the time-bucket fallback is absent for the 9 events that set
 * `dedupeWindowSeconds: 0` — mentions, DMs, invites — and they would double-deliver.
 * It is `replayKey` rather than `dedupeKey` because the outbox key is a random UUID
 * for any emission without an explicit caller key, and passing it as `dedupeKey` made
 * it override the declared window on every one of them.
 *
 * Runs per tenant via `forEachOrg`: `notification_outbox` enforces
 * `org_id = app.current_org_id()`, so a global sweep is denied `42501` (§20).
 */
@Injectable()
export class NotificationOutboxRelayService {
  private readonly logger = new Logger(NotificationOutboxRelayService.name);

  /**
   * Where the previous tick's budget ran out. In-process rather than persisted: a
   * lost cursor costs one unfair tick, and every claim is fenced by
   * `for update skip locked` plus its lease, so two relays starting from different
   * cursors cover the tenant list faster rather than less correctly.
   */
  private cursorOrgId: string | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async flush(): Promise<OutboxRelayResult> {
    const result: OutboxRelayResult = { claimed: 0, processed: 0, retried: 0, dead: 0 };
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);

    const claimed: Array<typeof notificationOutbox.$inferSelect> = [];
    let lastClaimedFromOrgId: string | null = null;

    await forEachOrg(
      this.db,
      "notification-outbox-relay",
      async (tx, orgId) => {
        const remaining = BATCH_SIZE - claimed.length;
        if (remaining <= 0) return;
        // The cap is what makes one tick serve several tenants; `remaining` is what
        // keeps the global budget honest when the last slice is smaller than the cap.
        const orgLimit = Math.min(remaining, OUTBOX_ORG_BATCH_CAP);

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
            limit ${orgLimit}
            for update skip locked
          )`,
          )
          .returning();
        if (rows.length === 0) return;
        claimed.push(...rows);
        lastClaimedFromOrgId = orgId;
      },
      "write",
      {
        // Where the last tick ran out of budget is where this one starts, so the
        // tenants a capped tick could not reach are the ones served first next time.
        // The cap alone would still serve the same lowest five organizations forever.
        startAfterOrgId: this.cursorOrgId,
        // Not the `remaining <= 0` guard alone: that already cost one tenant
        // transaction per remaining organization in order to claim nothing.
        stopWhen: () => claimed.length >= BATCH_SIZE,
      },
    );

    // Only a tick that ran out of budget leaves a cursor. A tick that drained every
    // tenant has no one to be fair to, so the next one starts from the top and stays
    // deterministic.
    this.cursorOrgId = claimed.length >= BATCH_SIZE ? lastClaimedFromOrgId : null;

    result.claimed = claimed.length;
    if (claimed.length === 0) return result;

    for (const row of claimed) {
      try {
        if (!isNotificationEventKey(row.eventKey))
          throw new Error(`event key is not in the catalog: ${row.eventKey}`);

        await this.dispatch.emitNow({
          eventKey: row.eventKey,
          orgId: row.orgId,
          // The row's key is a REPLAY discriminator, not a caller dedupe key: passing
          // it as the latter overrode the event's declared dedupe window on every
          // emission that did not supply a key of its own.
          replayKey: row.dedupeKey,
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
