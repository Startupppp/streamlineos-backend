import { and, eq } from "drizzle-orm";
import { inboxRecords } from "../../db/schema/outbox";
import { type DbOrTx } from "../rbac/access-invalidate";

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
  aggregateVersion: number;
}

/**
 * Consumer-side exactly-once fence over the outbox. `claim` atomically records a
 * (producer event, consumer) row; a duplicate redelivery hits the unique index and is skipped,
 * so the handler runs at most once even under at-least-once delivery.
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
        aggregateVersion: event.aggregateVersion,
        status: "PENDING",
      })
      .onConflictDoNothing({
        target: [inboxRecords.producerEventId, inboxRecords.consumerName],
      })
      .returning({ id: inboxRecords.inboxRecordId });
    return inserted.length > 0;
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
  }
}
