import { sql } from "drizzle-orm";
import { type DbOrTx } from "../rbac/access-invalidate";

/**
 * The next `aggregate_version` for one aggregate, taken inside the caller's
 * transaction.
 *
 * `uniq_outbox_events_org_agg_version` is unique on
 * (organization_id, aggregate_type, aggregate_id, aggregate_version), so a
 * producer that hardcodes `1` can emit exactly one event per aggregate, ever.
 * That was true of the only recruitment producer there used to be — the legacy
 * apply — and stopped being true the moment a candidate could also be moved,
 * hired and handed off: the second event for that candidate failed `23505` and
 * took its whole business transaction with it.
 *
 * A timestamp (`Date.now()`) is the other idiom in this codebase and is not
 * enough here, because two events for the same aggregate are emitted together
 * in the same millisecond. A counted sequence is also the more useful number:
 * `inbox-consumer.ts` compares versions to decide whether an event is stale.
 *
 * Concurrency is left to the unique index. Two transactions emitting for the
 * same aggregate can compute the same next value; the second one's INSERT is
 * refused and it rolls back, which is the correct outcome for a producer whose
 * aggregate genuinely changed twice at once.
 */
export async function nextAggregateVersions(
  tx: DbOrTx,
  aggregate: { organizationId: string; aggregateType: string; aggregateId: string },
  count = 1,
): Promise<number[]> {
  const rows = await tx.execute<{ next: string }>(
    sql`SELECT COALESCE(MAX(aggregate_version), 0) + 1 AS next
          FROM outbox_events
         WHERE organization_id = ${aggregate.organizationId}
           AND aggregate_type = ${aggregate.aggregateType}
           AND aggregate_id = ${aggregate.aggregateId}`,
  );
  const start = Number(rows[0]?.next ?? 1);
  return Array.from({ length: count }, (_, index) => start + index);
}

export async function nextAggregateVersion(
  tx: DbOrTx,
  aggregate: { organizationId: string; aggregateType: string; aggregateId: string },
): Promise<number> {
  const [version] = await nextAggregateVersions(tx, aggregate, 1);
  return version ?? 1;
}
