import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { organizations, outboxEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  nextRetryDelayMs,
  shouldDeadLetter,
  shouldSuppressForLifecycle,
} from "./outbox-envelope";

const BATCH_SIZE = 50;
const LEASE_MS = 30_000;

type OutboxEventRow = typeof outboxEvents.$inferSelect;

export interface OutboxFlushResult {
  claimed: number;
  delivered: number;
  suppressed: number;
  retried: number;
  dead: number;
}

/**
 * Drains the transactional outbox: atomically leases a batch of due PENDING events (and reclaims
 * expired IN_FLIGHT leases from a crashed worker), re-checks the owning organization's lifecycle
 * immediately before delivery (an archived/purged org is SUPPRESSED, never delivered), then marks
 * each DELIVERED or reschedules with bounded backoff / dead-letters past the retry ceiling.
 * Phase 1 records delivery in-place; `deliver` is the single seam to swap for broker dispatch.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private noBrokerWarned = false;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Returns true only once a real broker is injected and deliver() is implemented.
   * Phase-1 default is false: flush() is a deliberate no-op so events stay PENDING
   * (unclaimed) until a real dispatch target is wired, rather than being falsely
   * marked DELIVERED. Override in a concrete subclass or swap to true here when
   * wiring Kafka / SQS / EventBus dispatch.
   */
  protected isDispatchConfigured(): boolean {
    return false;
  }

  async flush(): Promise<OutboxFlushResult> {
    if (!this.isDispatchConfigured()) {
      if (!this.noBrokerWarned) {
        this.logger.warn(
          "OutboxPublisher: no dispatch target is configured — flush is a no-op; events remain " +
            "PENDING and will be retried when a broker is wired. Override isDispatchConfigured() " +
            "and implement deliver() to enable real dispatch. (Further warnings suppressed.)",
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
        await this.mark(event.outboxEventId, "SUPPRESSED");
        suppressed++;
        continue;
      }
      try {
        await this.deliver(event);
        await this.mark(event.outboxEventId, "DELIVERED", { publishedAt: new Date() });
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
    const dueIds = this.db
      .select({ id: outboxEvents.outboxEventId })
      .from(outboxEvents)
      .where(
        or(
          and(
            eq(outboxEvents.deliveryState, "PENDING"),
            or(
              isNull(outboxEvents.leaseExpiresAt),
              lte(outboxEvents.leaseExpiresAt, now),
            ),
          ),
          and(
            eq(outboxEvents.deliveryState, "IN_FLIGHT"),
            lte(outboxEvents.leaseExpiresAt, now),
          ),
        ),
      )
      .limit(BATCH_SIZE);

    return this.db
      .update(outboxEvents)
      .set({
        deliveryState: "IN_FLIGHT",
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      })
      .where(inArray(outboxEvents.outboxEventId, dueIds))
      .returning();
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
    // Replace this body with real EventBus / Kafka / SQS dispatch, keyed on event.eventType
    // or event.aggregateType prefix. This method is only called once isDispatchConfigured()
    // returns true — throwing here prevents any uncaught "delivered" marking if someone
    // overrides isDispatchConfigured() before wiring a real dispatch target.
    throw new Error(
      `no dispatch handler for event type '${event.eventType}' — implement routing in deliver()`,
    );
  }

  private async handleFailure(
    event: OutboxEventRow,
    error: unknown,
  ): Promise<"DEAD" | "RETRY"> {
    const message = error instanceof Error ? error.message : String(error);
    const retryCount = event.retryCount + 1;

    if (shouldDeadLetter(retryCount)) {
      await this.db
        .update(outboxEvents)
        .set({
          deliveryState: "DEAD",
          retryCount,
          lastError: message,
          deadLetteredAt: new Date(),
        })
        .where(eq(outboxEvents.outboxEventId, event.outboxEventId));
      this.logger.error(
        `outbox ${event.eventId} dead-lettered after ${retryCount} attempts: ${message}`,
      );
      return "DEAD";
    }

    await this.db
      .update(outboxEvents)
      .set({
        deliveryState: "PENDING",
        retryCount,
        lastError: message,
        leaseExpiresAt: new Date(Date.now() + nextRetryDelayMs(retryCount)),
      })
      .where(eq(outboxEvents.outboxEventId, event.outboxEventId));
    return "RETRY";
  }

  private async mark(
    outboxEventId: number,
    deliveryState: "DELIVERED" | "SUPPRESSED",
    extra: { publishedAt?: Date } = {},
  ): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({ deliveryState, ...extra })
      .where(eq(outboxEvents.outboxEventId, outboxEventId));
  }
}
