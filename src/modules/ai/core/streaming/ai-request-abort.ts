import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getTenantAbortSignal } from "../../../../common/tenant/tenant-context";

/**
 * What a single AI-bearing HTTP request carries for the code beneath it.
 *
 * The cancellation signal was here first; the caller's `Idempotency-Key` joins
 * it because it has the same shape of problem — it is known only at the HTTP
 * boundary, and needed 4 or 5 frames down inside the gateway, on routes whose
 * ~124 call sites cannot all be asked to thread a new argument.
 */
export interface AiRequestScope {
  signal: AbortSignal;
  /** The caller's `Idempotency-Key` header, trimmed. Absent on most requests. */
  idempotencyKey?: string;
  /**
   * Which metered call within this request is being made. A request may reach
   * the gateway more than once, and two calls must not share a reservation key
   * or the second would silently reuse the first reservation and go unbilled. A
   * REPLAY of the same request repeats the same sequence of calls, so call *n*
   * of the replay composes the same key as call *n* of the original, which is
   * exactly the match the reservation's unique index needs.
   */
  sequence: { next: number };
}

const storage = new AsyncLocalStorage<AiRequestScope>();

export function runWithAiRequestScope<T>(
  scope: Omit<AiRequestScope, "sequence">,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ ...scope, sequence: { next: 0 } }, fn);
}

export function runWithAiRequestAbort<T>(
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithAiRequestScope({ signal }, fn);
}

/** `varchar(120)`; the composed key below is `ai:` plus 64 hex characters. */
const KEY_PREFIX = "ai:";

/**
 * A byte that cannot occur in any of the fields, so `("a", "bc")` and
 * `("ab", "c")` cannot hash to the same key.
 */
const FIELD_SEPARATOR = "\u0000";

/**
 * The reservation key for the next metered call in this request, or `undefined`
 * when the caller sent no `Idempotency-Key`.
 *
 * `AiCreditsReservationService.reserve` already implements the whole guard — the
 * pre-read on `(org_id, idempotency_key)`, the debit inside the transaction and
 * the 23505 recovery when two replays race — behind the partial unique index
 * `uq_ai_credit_res_org_idem_key`. Nothing supplied the key, so a proxy or
 * mobile client that retried a POST the backend had already completed reserved
 * again, called the provider again and settled again: the organisation was
 * billed twice for one answer and `ai_usage_logs` showed two `ok` turns.
 *
 * The key is hashed rather than concatenated because the header is caller-
 * controlled and the column is `varchar(120)`, and the feature, tenant and actor
 * are folded in so one client key cannot be replayed across features or across
 * users who happen to share it.
 *
 * Streaming routes cannot use `@Idempotent` — the response is not replayable —
 * so for those this reservation key is the only guard available.
 */
export function aiReservationIdempotencyKey(
  feature: string,
  actor: { orgId: string; userId: string | null },
): string | undefined {
  const scope = storage.getStore();
  const requestKey = scope?.idempotencyKey;
  if (scope === undefined || requestKey === undefined || requestKey === "") return undefined;

  const sequence = scope.sequence.next;
  scope.sequence.next += 1;

  const digest = createHash("sha256")
    .update(
      [requestKey, feature, actor.orgId, actor.userId ?? "", String(sequence)].join(FIELD_SEPARATOR),
    )
    .digest("hex");

  return `${KEY_PREFIX}${digest}`;
}

/**
 * Every AI controller is `@NoTenantTransaction()`, so the abort signal the
 * tenant interceptor builds is never established on these routes and the gateway
 * would have nothing to cancel with. This is the request-scoped signal the AI
 * surfaces run under; background work (jobs, cron, outbox) has none, which is
 * why the gateway treats an absent signal as "nothing to cancel" rather than
 * synthesising one.
 */
export function getAiRequestAbortSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/**
 * The cancellation signal armed for the current request, whichever interceptor
 * armed it. `AiRequestAbortInterceptor` is the only source on the
 * `@NoTenantTransaction()` AI routes, but 19 metered controllers reach the
 * gateway without ever opting into it — and on those a client that hung up
 * handed the provider no signal at all, so the org paid for a completion nobody
 * would read. Every authenticated route already carries a disconnect signal on
 * the tenant context; reading it here is what closes them. Background work
 * (jobs, cron, outbox) still has neither, so an absent signal stays "nothing to
 * cancel" rather than a synthesised one.
 */
export function getAmbientAiAbortSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal ?? getTenantAbortSignal();
}
