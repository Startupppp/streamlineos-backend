import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { outboxEvents } from "../../db/schema/common/outbox";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { type DbOrTx } from "../../common/rbac/access-invalidate";
import { EXPENSE_AGGREGATE_TYPE } from "./dto/expense-outbox.schemas";

interface EmitExpenseEventInput {
  orgId: string;
  expenseId: number;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * The aggregate version comes from the outbox itself, not from a clock:
 * `uniq_outbox_events_org_agg_version` is unique, and two transitions of one expense within the
 * same millisecond would collide on a timestamp version and roll the business write back. Emit
 * only AFTER the UPDATE, so the row lock that UPDATE takes serialises concurrent transitions of
 * the same expense and makes max+1 safe.
 */
export async function emitExpenseOutboxEvent(
  tx: DbOrTx,
  input: EmitExpenseEventInput,
): Promise<void> {
  const aggregateId = String(input.expenseId);

  const [current] = await tx
    .select({
      maxVersion: sql<number>`coalesce(max(${outboxEvents.aggregateVersion}), 0)`,
    })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.organizationId, input.orgId),
        eq(outboxEvents.aggregateType, EXPENSE_AGGREGATE_TYPE),
        eq(outboxEvents.aggregateId, aggregateId),
      ),
    );

  const nextVersion = Number(current?.maxVersion ?? 0) + 1;

  await OutboxWriter.emit(tx, {
    eventId: randomUUID(),
    organizationId: input.orgId,
    aggregateType: EXPENSE_AGGREGATE_TYPE,
    aggregateId,
    aggregateVersion: Number.isFinite(nextVersion) && nextVersion > 0 ? nextVersion : 1,
    eventType: input.eventType,
    payload: input.payload,
    occurredAt: new Date(),
  });
}
