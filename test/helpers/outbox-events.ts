import { sql } from "drizzle-orm";
import type { Db } from "src/db/drizzle.module";

/**
 * Reading the real `outbox_events` rows a command left behind.
 *
 * A5, item 3. Every suite that proves a command emits its event needs the same
 * query, and the property under test is a *count* — exactly one row per accepted
 * command, none for a replay, none for work that rolled back. Six private copies
 * of this would drift, and the first one to lose its `event_type` filter would
 * pass against any event at all.
 *
 * Call inside a tenant transaction: `outbox_events` is org-scoped and the org id
 * is asserted here as well, so a leak shows up as an empty result rather than as
 * another tenant's events counted into an assertion.
 */
export interface OutboxEventRecord {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export async function outboxEventsFor(
  db: Db,
  orgId: string,
  eventType: string,
  aggregateId?: string,
): Promise<OutboxEventRecord[]> {
  const rows = await db.execute<{
    event_id: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: unknown;
  }>(sql`
    SELECT event_id, event_type, aggregate_type, aggregate_id, payload
      FROM outbox_events
     WHERE organization_id = ${orgId}
       AND event_type = ${eventType}
       ${aggregateId === undefined ? sql`` : sql`AND aggregate_id = ${aggregateId}`}
     ORDER BY outbox_event_id
  `);

  return rows.map((row) => ({
    eventId: row.event_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }));
}
