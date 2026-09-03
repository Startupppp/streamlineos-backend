import { resolveTransactionGuards } from "../../db/pool.config";

/**
 * Room for the rollback and the bookkeeping write that follow an abandoned
 * delivery, on both sides: below the database's own guard, and below the lease.
 */
const DEADLINE_MARGIN_MS = 15_000;

/** Used only when the idle guard is switched off (`0`), which leaves nothing to derive from. */
const DEADLINE_WITHOUT_A_GUARD_MS = 45_000;

/**
 * The wall-clock budget one consumer's `handle()` gets.
 *
 * Derived from `idle_in_transaction_session_timeout` — the guard `withTenant`
 * sets on the very transaction this runs inside — rather than chosen, so
 * lowering that guard cannot silently leave the deadline above it and useless.
 * Beyond that guard the outcome is not a slow delivery but a dead one: Postgres
 * kills the connection, the transaction is gone, and the delivery cannot record
 * what happened to it. Stopping first is the whole point.
 *
 * NOT set from the lease, though it is also below it. A tighter bound would have
 * aborted consumers that legitimately run for tens of seconds — `KbIngestionConsumer`
 * embeds a document inline — turning work that completes today into a retry loop
 * that dead-letters. Bounding what is certainly lost, and nothing more, is the
 * bound that cannot introduce a new failure.
 */
export const OUTBOX_DELIVERY_DEADLINE_MS = (() => {
  const idleGuardMs = resolveTransactionGuards(process.env).idleInTransactionMs;
  return idleGuardMs > 0
    ? Math.max(5_000, idleGuardMs - DEADLINE_MARGIN_MS)
    : DEADLINE_WITHOUT_A_GUARD_MS;
})();

export class OutboxDeliveryDeadlineError extends Error {
  constructor(
    readonly eventType: string,
    readonly deadlineMs: number,
  ) {
    super(
      `outbox consumer for '${eventType}' exceeded its ${deadlineMs}ms delivery deadline ` +
        `and was abandoned; the event will be retried`,
    );
    this.name = "OutboxDeliveryDeadlineError";
  }
}

/**
 * Runs a consumer's `handle()` under a hard wall-clock bound, and stays
 * responsible for the work it abandons.
 *
 * WHY A BOUND IS NEEDED AT ALL. Delivery runs inside a tenant transaction — a
 * pooled connection reserved from BEGIN to COMMIT — and two live consumer chains
 * reach a provider from inside it. `ProjectsWebhooksDispatchService` dispatches
 * through `callProvider` at 5 attempts x 10s plus up to 15s of full-jitter
 * backoff, so a customer endpoint that accepts the connection and never answers
 * costs ~65s; `ExpenseSubmittedConsumer` reaches an LLM through
 * `AutomationService` -> `aiNodeExecutor` on a comparable budget. Both exceed
 * `idle_in_transaction_session_timeout` (60s, set per transaction by
 * `withTenant`), so Postgres kills the connection out from under the delivery.
 *
 * WHAT THAT COST. The failure lands with the transaction already dead and, once
 * the next tick has re-claimed the row, with the lease it was fenced on gone
 * too: `retryCount` never advances, `shouldDeadLetter` never fires, and the
 * event is re-delivered — and re-POSTed — on every tick indefinitely. Meanwhile
 * the batch is processed serially, so one such endpoint stalls every other
 * tenant's events behind it for the length of the stall.
 *
 * WHAT THIS DOES INSTEAD. Failing at the deadline is not a new failure mode; it
 * is the same one, moved to a moment when the transaction is still ours to roll
 * back and the lease is still ours to write under, so the outcome is an ordinary
 * recorded retry that `shouldDeadLetter` terminates.
 *
 * WHY THE ABANDONED PROMISE IS NOT DROPPED. Its continuation still resolves
 * `this.db` to this transaction's `tx` through the ambient tenant context, so
 * its next statement rejects once the transaction rolls back. An unobserved
 * rejection is fatal under Node's default `--unhandled-rejections=throw`, so it
 * is handed to `onAbandoned` — which must log it, never swallow it: an
 * abandoned delivery that then failed is the signal that the deadline is doing
 * real work.
 */
export async function withDeliveryDeadline<T>(
  eventType: string,
  deadlineMs: number,
  run: () => Promise<T>,
  onAbandoned: (error: unknown) => void,
): Promise<T> {
  const work = run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new OutboxDeliveryDeadlineError(eventType, deadlineMs));
    }, deadlineMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } catch (error: unknown) {
    if (expired) work.catch(onAbandoned);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
