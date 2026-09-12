import { runCarrierCall, TerminalCarrierError } from "../carrier-adapter";
import type { CarrierTransportResult } from "../transport/carrier-transport.port";
import type { CarrierOperationKind } from "./carrier-operations";

/**
 * INV-26 — one courier call under the shared retry ladder, and what its answer
 * means afterwards.
 *
 * Separated from `CarrierTransportService` because the three operations differ
 * only in which adapter method they call: the ladder, the terminal/retryable
 * split and the reading of a failure back into an operator's sentence are
 * identical for all of them, and were the third copy of that reasoning waiting
 * to drift.
 */

/** What one book/label/track attempt did, in terms a screen renders verbatim. */
export interface CarrierOperationResult {
  shipmentId: number;
  operation: CarrierOperationKind;
  outcome: "accepted" | "rejected" | "unavailable";
  attempts: number;
  transport: string | null;
  carrierReference: string | null;
  trackingNumber: string | null;
  labelUrl: string | null;
  labelFormat: string | null;
  /** Tracking events this call actually added. Zero on anything but a track. */
  recorded: number;
  /** The courier's own words on a failure, or null on success. */
  message: string | null;
}

export type CarrierCallOutcome<T> = CarrierTransportResult<T> & { attempts: number };

/**
 * Runs one adapter call through `runCarrierCall`.
 *
 * The ladder retries a *throw*, and an adapter reports by value — so the two
 * failure kinds are re-thrown differently and the difference is the whole
 * point. `unavailable` becomes an ordinary Error, which the ladder retries,
 * because the courier may simply be down and the request may be perfectly good.
 * `rejected` becomes `TerminalCarrierError`, which the ladder refuses to retry,
 * because the courier has read the request and said no: asking twice more turns
 * one wrong answer into three, and on a booking endpoint it can turn one wrong
 * answer into three consignments.
 *
 * Everything comes back as a value, including a dead letter. Every caller's
 * correct response to "the courier is unreachable" is the same — carry on, and
 * record it — and a throw here would invite one of them to roll back a
 * shipment whose goods are already on a van.
 */
export async function callCarrier<T>(
  work: () => Promise<CarrierTransportResult<T>>,
): Promise<CarrierCallOutcome<T>> {
  const call = await runCarrierCall(async () => {
    const result = await work();
    if (result.outcome === "unavailable") throw new Error(result.reason);
    if (result.outcome === "rejected") {
      throw new TerminalCarrierError(JSON.stringify(result.errors));
    }
    return result;
  });

  if (call.ok) return { ...call.value, attempts: call.attempts };

  const rejected = parseRejection(call.error);
  return rejected
    ? { outcome: "rejected", errors: rejected, attempts: call.attempts }
    : { outcome: "unavailable", reason: call.error, attempts: call.attempts };
}

/** The courier's first error code, which is what an operator searches for. */
export function failureCode(result: CarrierTransportResult<unknown>): string | null {
  if (result.outcome === "rejected") return result.errors[0]?.code ?? "rejected";
  if (result.outcome === "unavailable") return "unavailable";
  return null;
}

export function failureMessage(result: CarrierTransportResult<unknown>): string | null {
  if (result.outcome === "rejected") {
    return result.errors.map((error) => `${error.code}: ${error.message}`).join("; ");
  }
  if (result.outcome === "unavailable") return result.reason;
  return null;
}

export function toOperationResult(
  shipmentId: number,
  operation: CarrierOperationKind,
  transport: string,
  result: CarrierCallOutcome<unknown>,
  detail: {
    carrierReference: string | null;
    trackingNumber: string | null;
    labelUrl: string | null;
    labelFormat: string | null;
  },
): CarrierOperationResult {
  return {
    shipmentId,
    operation,
    outcome: result.outcome,
    attempts: result.attempts,
    transport,
    ...detail,
    recorded: 0,
    message: failureMessage(result),
  };
}

/**
 * Reads a rejection back out of the string the ladder carried it through in.
 *
 * `runCarrierCall`'s contract is a string `error`, so a courier's structured
 * errors have to survive one round trip through JSON. Anything that does not
 * parse back into that exact shape was a genuine transport failure and is
 * treated as one — including, deliberately, a courier whose own error message
 * happens to be JSON but not this shape.
 */
function parseRejection(
  error: string,
): ReadonlyArray<{ code: string; message: string }> | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(error);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded)) return null;

  const errors: Array<{ code: string; message: string }> = [];
  for (const entry of decoded) {
    if (typeof entry !== "object" || entry === null) return null;
    const code = Reflect.get(entry, "code");
    const message = Reflect.get(entry, "message");
    if (typeof code !== "string" || typeof message !== "string") return null;
    errors.push({ code, message });
  }
  return errors;
}
