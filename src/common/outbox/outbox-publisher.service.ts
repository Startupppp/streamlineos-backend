import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { organizations, outboxEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import {
  nextRetryDelayMs,
  shouldDeadLetter,
  shouldSuppressForLifecycle,
} from "./outbox-envelope";
import { OutboxConsumerRegistry, type OutboxEventRow } from "./outbox-consumer.registry";
import { runInNewTenantTransaction } from "../tenant/run-in-tenant-transaction";
import { forEachOrg } from "../tenant";

const BATCH_SIZE = 50;
const LEASE_MS = 30_000;

export interface OutboxFlushResult {
  claimed: number;
  delivered: number;
  suppressed: number;
  retried: number;
  dead: number;
}

/**
 * Drains the transactional outbox: leases a batch of due PENDING events per organisation (each in
 * its own tenant transaction via forEachOrg — a cross-org sweep has no ambient GUC and is denied
 * 42501 by the outbox_events RLS policy), re-checks the owning organisation's lifecycle immediately
 * before delivery, then marks each DELIVERED or reschedules with bounded backoff / dead-letters past
 * the retry ceiling. Event types with no registered consumer are SUPPRESSED, not retried — "nobody
 * subscribed" is not a delivery failure; an event is never marked DELIVERED without a consumer
 * having handled it. All state mutations run in their own per-org tenant transaction.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private noBrokerWarned = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  private isDispatchConfigured(): boolean {
    return this.config.OUTBOX_DISPATCH_ENABLED === "true";
  }

  async flush(): Promise<OutboxFlushResult> {
    if (!this.isDispatchConfigured()) {
      if (!this.noBrokerWarned) {
        this.logger.warn(
          "OutboxPublisher: no dispatch target is configured — flush is a no-op; events remain " +
            "PENDING and will be retried when a broker is wired. Set OUTBOX_DISPATCH_ENABLED=true " +
            "and register consumers to enable real dispatch. (Further warnings suppressed.)",
        );
        this.noBrokerWarned = true;
      }
      return { claimed: 0, delivered: 0, suppressed: 0, retried: 0, dead: 0 };
    }
    const claimed = await this.claimBatch();
    let delivered = 0;
    let suppressed = 0;
    let retried = 0;
    let dead = 0;

    for (const event of claimed) {
      const lifecycle = await this.readOrgLifecycle(event.organizationId);
      if (!lifecycle.found || shouldSuppressForLifecycle(lifecycle.status)) {
        await this.mark(event, "SUPPRESSED");
        suppressed++;
        continue;
      }
      if (!this.registry.get(event.eventType)) {
        this.logger.warn(
          `outbox event ${event.eventId} type '${event.eventType}' has no registered consumer — suppressing`,
        );
        await this.mark(event, "SUPPRESSED");
        suppressed++;
        continue;
      }
      try {
        await this.deliver(event);
        await this.mark(event, "DELIVERED", { publishedAt: new Date() });
        delivered++;
      } catch (error: unknown) {
        const outcome = await this.handleFailure(event, error);
        if (outcome === "DEAD") dead++;
        else retried++;
      }
    }

    return { claimed: claimed.length, delivered, suppressed, retried, dead };
  }

  private async claimBatch(): Promise<OutboxEventRow[]> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const claimed: OutboxEventRow[] = [];

    await forEachOrg(this.db, "outbox-events-flush", async (tx, orgId) => {
      const remaining = BATCH_SIZE - claimed.length;
      if (remaining <= 0) return;

      const rows = await tx
        .update(outboxEvents)
        .set({
          deliveryState: "IN_FLIGHT",
          leaseExpiresAt: leaseUntil,
        })
        .where(
          sql`${outboxEvents.outboxEventId} in (
            select outbox_event_id from ${outboxEvents}
            where organization_id = ${orgId}
              and (
                (delivery_state = 'PENDING' and (lease_expires_at is null or lease_expires_at <= ${now.toISOString()}::timestamptz))
                or (delivery_state = 'IN_FLIGHT' and lease_expires_at <= ${now.toISOString()}::timestamptz)
              )
            order by outbox_event_id
            limit ${remaining}
            for update skip locked
          )`,
        )
        .returning();

      claimed.push(...rows);
    });

    return claimed;
  }

  private async readOrgLifecycle(
    organizationId: string,
  ): Promise<{ found: boolean; status: string }> {
    const rows = await this.db
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const row = rows[0];
    if (!row) return { found: false, status: "PURGED" };
    return { found: true, status: row.status ?? "ACTIVE" };
  }

  private async deliver(event: OutboxEventRow): Promise<void> {
    const consumer = this.registry.get(event.eventType);
    if (!consumer) {
      throw new Error(
        `no dispatch handler for event type '${event.eventType}' — register a consumer via OutboxConsumerRegistry`,
      );
    }
    await runInNewTenantTransaction(this.db, event.organizationId, async () => {
      await consumer.handle(event);
    });
  }

  private async handleFailure(
    event: OutboxEventRow,
    error: unknown,
  ): Promise<"DEAD" | "RETRY"> {
    const message = error instanceof Error ? error.message : String(error);
    const retryCount = event.retryCount + 1;

    if (shouldDeadLetter(retryCount)) {
      await runInNewTenantTransaction(this.db, event.organizationId, async (tx) => {
        await tx
          .update(outboxEvents)
          .set({
            deliveryState: "DEAD",
            retryCount,
            lastError: message,
            deadLetteredAt: new Date(),
          })
          .where(eq(outboxEvents.outboxEventId, event.outboxEventId));
      });
      this.logger.error(
        `outbox ${event.eventId} dead-lettered after ${retryCount} attempts: ${message}`,
      );
      return "DEAD";
    }

    await runInNewTenantTransaction(this.db, event.organizationId, async (tx) => {
      await tx
        .update(outboxEvents)
        .set({
          deliveryState: "PENDING",
          retryCount,
          lastError: message,
          leaseExpiresAt: new Date(Date.now() + nextRetryDelayMs(retryCount)),
        })
        .where(eq(outboxEvents.outboxEventId, event.outboxEventId));
    });
    return "RETRY";
  }

  private async mark(
    event: OutboxEventRow,
    deliveryState: "DELIVERED" | "SUPPRESSED",
    extra: { publishedAt?: Date } = {},
  ): Promise<void> {
    await runInNewTenantTransaction(this.db, event.organizationId, async (tx) => {
      await tx
        .update(outboxEvents)
        .set({ deliveryState, ...extra })
        .where(eq(outboxEvents.outboxEventId, event.outboxEventId));
    });
  }
}
