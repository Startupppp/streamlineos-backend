import { outboxEvents } from "../../db/schema/common/outbox";
import { buildOutboxEvent } from "./outbox-envelope";
import { type OutboxEventInput } from "./outbox-event-schema";
import { type DbOrTx } from "../rbac/access-invalidate";

/**
 * Writes a domain event into the transactional outbox inside the caller's transaction, so the
 * aggregate mutation and its event are committed atomically. Producers call this within their
 * existing `db.transaction(async (tx) => …)` — never as a separate write.
 */
export const OutboxWriter = {
  async emit(tx: DbOrTx, input: OutboxEventInput): Promise<void> {
    await tx.insert(outboxEvents).values(buildOutboxEvent(input));
  },
};
