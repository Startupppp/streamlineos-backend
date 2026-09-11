import { sql } from "drizzle-orm";
import { outboxEvents } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../tenant";
import type { OutboxEventRow } from "./outbox-consumer.registry";
import { OUTBOX_DELIVERY_DEADLINE_MS } from "./outbox-delivery-deadline";

export const OUTBOX_BATCH_SIZE = 50;

/**
 * How long a claim owns an event.
 *
 * Derived from the delivery deadline, not chosen: every bookkeeping write in the
 * publisher is fenced on `(IN_FLIGHT, this exact lease)`, so a delivery that
 * outruns its lease can have its row re-claimed by the next tick and its own
 * result — success or failure — silently discarded. At the previous fixed 30s
 * the fence was true only by luck, because the delivery it fenced had no bound
 * at all; now the lease covers the longest delivery the deadline permits, plus
 * the write that records its outcome.
 *
 * The cost of the longer lease is recovery latency: after a worker crashes, its
 * in-flight events wait out the lease before another worker may re-claim them.
 * That is the right trade for a fence that actually holds — a duplicate delivery
 * is a correctness event, a slower retry is not.
 */
export const OUTBOX_LEASE_MS = OUTBOX_DELIVERY_DEADLINE_MS + 15_000;

/**
 * Chooses which events this tick owns, fairly across tenants.
 *
 * Claiming is its own responsibility, separate from delivering: it answers "who
 * goes now, and for how long", where delivery answers "what happens to one
 * event". They fail differently too — a claim bug starves a tenant, a delivery
 * bug loses or duplicates an effect.
 */
export class OutboxBatchClaimer {
  /** Where the last tick's batch budget ran out; see `claim`. */
  private cursorOrgId: string | null = null;

  constructor(private readonly db: Db) {}

  /**
   * Claims up to `OUTBOX_BATCH_SIZE` events across tenants, starting where the
   * last tick stopped.
   *
   * The budget is shared and `forEachOrg` enumerates by ascending org id, so a
   * fixed starting point starves: an organization mid-bulk-import whose backlog
   * exceeds 50 takes the entire tick, every tick, and an organization later in
   * the id order — whose one waiting event may be a payroll posting intent — is
   * never claimed at all. Rotating the entry point bounds that: every tenant is
   * reached within one pass over the tenant list, however saturated the others.
   *
   * A fixed per-organization cap was the other candidate and was rejected: it
   * would cut a single-tenant deployment's drain rate by the same factor it
   * bounds contention by, and does not bound starvation on its own once more
   * than `OUTBOX_BATCH_SIZE / cap` tenants are backlogged.
   *
   * The cursor is per process and deliberately not persisted. It is a fairness
   * heuristic, not correctness — every event is still claimed under
   * `for update skip locked` and fenced by its lease — and two workers running
   * from different cursors cover the tenant list faster, not less correctly.
   */
  async claim(): Promise<OutboxEventRow[]> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MS);
    const claimed: OutboxEventRow[] = [];
    let lastClaimedFromOrgId: string | null = null;

    await forEachOrg(
      this.db,
      "outbox-events-flush",
      async (tx, orgId) => {
        const remaining = OUTBOX_BATCH_SIZE - claimed.length;
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

        if (rows.length === 0) return;
        claimed.push(...rows);
        lastClaimedFromOrgId = orgId;
      },
      "write",
      {
        startAfterOrgId: this.cursorOrgId,
        // Not the `remaining <= 0` guard above on its own: that already cost one
        // tenant transaction per remaining organization to claim nothing.
        stopWhen: () => claimed.length >= OUTBOX_BATCH_SIZE,
      },
    );

    // Only a tick that ran out of budget leaves a cursor. A tick that drained
    // every tenant has no one to be fair to, so the next one starts from the top
    // and stays deterministic.
    this.cursorOrgId = claimed.length >= OUTBOX_BATCH_SIZE ? lastClaimedFromOrgId : null;

    return claimed;
  }
}
