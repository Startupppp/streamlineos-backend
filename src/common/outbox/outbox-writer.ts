import { outboxEvents } from "../../db/schema/common/outbox";
import { buildOutboxEvent } from "./outbox-envelope";
import { type OutboxEventInput } from "./outbox-event-schema";
import { type DbOrTx } from "../rbac/access-invalidate";
import { getObservabilityContext } from "../observability/observability-context";

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The request's correlation id, when it is one the outbox column can hold.
 *
 * `outbox_events.correlation_id` is a uuid, and the edge accepts a caller-supplied
 * `x-correlation-id` of any shape, so an inbound id from another system is
 * carried on the log line but cannot be carried here. Dropping it is right:
 * a wrong value in the join column is worse than a null.
 */
function ambientCorrelationId(): string | null {
  const correlationId = getObservabilityContext()?.correlationId;
  if (correlationId === undefined) return null;
  return UUID_SHAPE.test(correlationId) ? correlationId : null;
}

/**
 * Writes a domain event into the transactional outbox inside the caller's transaction, so the
 * aggregate mutation and its event are committed atomically. Producers call this within their
 * existing `db.transaction(async (tx) => …)` — never as a separate write.
 *
 * The correlation id defaults to the ambient one rather than being a required
 * argument. The schema has carried the column since the outbox was introduced and
 * not one of the producers ever filled it, so every event committed with
 * `correlation_id = null` and nothing downstream — the publisher, the workflow
 * relay, a consumer's own log lines — could be joined back to the request that
 * caused it. A default at the single write site closes that for every producer,
 * including the ones not written yet; an explicit value still wins.
 */
export const OUTBOX_EMIT_CHUNK = 500;

export const OutboxWriter = {
  async emit(tx: DbOrTx, input: OutboxEventInput): Promise<void> {
    const correlationId = input.correlationId ?? ambientCorrelationId();
    await tx.insert(outboxEvents).values(buildOutboxEvent({ ...input, correlationId }));
  },

  async emitMany(tx: DbOrTx, inputs: readonly OutboxEventInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const ambient = ambientCorrelationId();
    for (let offset = 0; offset < inputs.length; offset += OUTBOX_EMIT_CHUNK) {
      const chunk = inputs.slice(offset, offset + OUTBOX_EMIT_CHUNK);
      await tx.insert(outboxEvents).values(
        chunk.map((input) =>
          buildOutboxEvent({ ...input, correlationId: input.correlationId ?? ambient }),
        ),
      );
    }
  },
};
