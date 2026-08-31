import { and, eq, or, sql } from "drizzle-orm";
import { inboxRecords } from "../../db/schema/common/outbox";
import { type DbOrTx } from "../rbac/access-invalidate";
import { getTenantContext } from "../tenant/tenant-context";

/**
 * Monotonic per-aggregate guard: only apply an event whose version is strictly newer than the
 * last version this consumer already applied for the aggregate. A never-seen aggregate (null)
 * always applies; a same/older version is a duplicate or out-of-order redelivery and is skipped.
 */
export function shouldProcessVersion(
  lastAppliedVersion: number | null,
  incomingVersion: number,
): boolean {
  if (lastAppliedVersion === null) return true;
  return incomingVersion > lastAppliedVersion;
}

export interface InboxEvent {
  eventId: string;
  organizationId: string;
  aggregateType?: string;
  aggregateId?: string;
  aggregateVersion: number;
}

/**
 * Consumer-side duplicate-suppression fence over the outbox. `claim` atomically
 * records a (producer event, consumer) row; a duplicate redelivery hits the
 * unique index and is skipped. This gives at-least-once delivery with
 * idempotent database application; external side effects require their own
 * stable idempotency keys.
 */
export class InboxConsumer {
  constructor(private readonly db: DbOrTx) {}

  async claim(consumerName: string, event: InboxEvent): Promise<boolean> {
    const inserted = await this.db
      .insert(inboxRecords)
      .values({
        producerEventId: event.eventId,
        consumerName,
        organizationId: event.organizationId,
        aggregateType: event.aggregateType ?? null,
        aggregateId: event.aggregateId ?? null,
        aggregateVersion: event.aggregateVersion,
        status: "IN_FLIGHT",
      })
      .onConflictDoNothing({
        target: [inboxRecords.producerEventId, inboxRecords.consumerName],
      })
      .returning({ id: inboxRecords.inboxRecordId });
    if (inserted.length > 0) {
      if (await this.isOlderThanApplied(consumerName, event)) {
        await this.markSkipped(consumerName, event);
        return false;
      }
      return true;
    }

    const existing = await this.readExisting(consumerName, event);
    const row = existing[0];
    if (!row) return false;
    if (row.status === "COMPLETED" || row.status === "SKIPPED") return false;
    if (row.status !== "FAILED" && row.status !== "IN_FLIGHT") return false;

    if (await this.isOlderThanApplied(consumerName, event)) {
      await this.markSkipped(consumerName, event);
      return false;
    }

    const reclaimed = await this.db
      .update(inboxRecords)
      .set({ status: "IN_FLIGHT", lastError: null, retryCount: sql`${inboxRecords.retryCount} + 1` })
      .where(
        and(
          eq(inboxRecords.producerEventId, event.eventId),
          eq(inboxRecords.consumerName, consumerName),
          or(
            eq(inboxRecords.status, "FAILED"),
            eq(inboxRecords.status, "IN_FLIGHT"),
          ),
        ),
      )
      .returning({ id: inboxRecords.inboxRecordId });
    return reclaimed.length > 0;
  }

  private async isOlderThanApplied(
    consumerName: string,
    event: InboxEvent,
  ): Promise<boolean> {
    if (!event.aggregateType || !event.aggregateId) return false;

    if (typeof this.db.execute !== "function") return false;

    const latest = await this.db.execute(sql`
      select aggregate_version as "aggregateVersion"
      from ${inboxRecords}
      where organization_id = ${event.organizationId}
        and consumer_name = ${consumerName}
        and aggregate_type = ${event.aggregateType}
        and aggregate_id = ${event.aggregateId}
        and status = 'COMPLETED'
      order by aggregate_version desc
      limit 1
    `) as unknown as Array<{ aggregateVersion: number }>;

    return Boolean(
      latest[0] && !shouldProcessVersion(latest[0].aggregateVersion, event.aggregateVersion),
    );
  }

  private async readExisting(
    consumerName: string,
    event: InboxEvent,
  ): Promise<Array<{ status: string; aggregateVersion: number }>> {
    if (typeof this.db.execute !== "function") return [];

    return await this.db.execute(sql`
      select status, aggregate_version as "aggregateVersion"
      from ${inboxRecords}
      where producer_event_id = ${event.eventId}
        and consumer_name = ${consumerName}
        and organization_id = ${event.organizationId}
      limit 1
    `) as unknown as Array<{ status: string; aggregateVersion: number }>;
  }

  private async markSkipped(consumerName: string, event: InboxEvent): Promise<void> {
    await this.db
      .update(inboxRecords)
      .set({ status: "SKIPPED", processedAt: new Date(), lastError: "out-of-order event" })
      .where(
        and(
          eq(inboxRecords.producerEventId, event.eventId),
          eq(inboxRecords.consumerName, consumerName),
          eq(inboxRecords.organizationId, event.organizationId),
        ),
      );
  }

  async markProcessed(
    consumerName: string,
    producerEventId: string,
    status: "COMPLETED" | "FAILED" | "SKIPPED",
    lastError: string | null = null,
  ): Promise<void> {
    await this.db
      .update(inboxRecords)
      .set({ status, processedAt: new Date(), lastError })
      .where(
        and(
          eq(inboxRecords.producerEventId, producerEventId),
          eq(inboxRecords.consumerName, consumerName),
        ),
      );
    // The relay owns the surrounding tenant transaction. Throw there so the outbox publisher
    // records a retry/dead-letter outcome; a direct unit caller still gets a durable FAILED row
    // without an unrelated transaction-context requirement.
    if (status === "FAILED" && getTenantContext()) {
      throw new Error(`Inbox consumer failed: ${lastError ?? "unknown error"}`);
    }
  }
}
