import { Injectable } from "@nestjs/common";
import type { CarrierStatusInput } from "./dto/carrier-status.schemas";

/**
 * B7, item 2 — the contract a carrier integration has to satisfy, and the one
 * implementation that exists.
 *
 * ## What this is, plainly
 *
 * **No real carrier is wired up.** There is no account, no credential column on
 * `inv_carriers`, and nothing in this repository has ever spoken to a courier.
 * So this is a *boundary*, exercised against a fake
 * (`__tests__/carrier-adapter.spec.ts`), not an integration exercised against a
 * carrier — and the only adapter registered at runtime is
 * `MANUAL_CARRIER_ADAPTER`, whose honest answer to "where is this parcel" is
 * "there is nobody to ask; the tracking number is whatever your operator typed".
 * Saying that in code beats saying it in a product note, because the frontend
 * can then render the truth rather than "coming soon".
 *
 * The point of writing the boundary before the integration is that the parts
 * which are easy to get wrong — retry, timeouts, what a dead letter means — are
 * fixed *now*, while they are cheap, and are the same for every carrier. What is
 * left for a real adapter is the part that is genuinely carrier-specific:
 * turning that carrier's payload into `CarrierTrackingEvent`s.
 *
 * ## What an adapter may not do
 *
 * An adapter never writes stock, and never writes a shipment row. It returns
 * *events*, and `CarrierStatusService` applies them under the rules it already
 * enforces — dedupe by the carrier's own event id, monotonic progress, tenant
 * resolution from our own tracking number rather than from anything the carrier
 * sent. That is what makes B7's item 3 true: an adapter that times out, throws,
 * or dead-letters cannot corrupt internal stock, because stock posts only on the
 * internal ship command and this code runs nowhere near it.
 *
 * ## Inbound webhooks
 *
 * There is no public carrier-webhook URL. The only ingest is
 * `POST /inventory/shipments/carrier-status`, which is behind `JwtAuthGuard` and
 * `inventory:shipments:manage`. HMAC verification is therefore not yet
 * applicable, and inventing a scheme now would be inventing it for a carrier
 * whose scheme we have not read: every courier signs differently. When a URL is
 * exposed, the receiver's half already exists in
 * `webhooks/webhook-signature.ts` for our own scheme, and a carrier-specific one
 * belongs on that carrier's adapter beside the payload parsing it also owns.
 */

/**
 * One thing a carrier claims happened, in our vocabulary rather than theirs.
 *
 * Deliberately the *same* type the in-app POST is validated into, so an adapter
 * and the manual path cannot drift into two shapes of the same fact — and so a
 * new adapter's output is checked by a schema that already exists.
 */
export type CarrierTrackingEvent = CarrierStatusInput;

export interface CarrierTrackingRequest {
  /** Our tracking number, which is the only handle a carrier is asked about. */
  readonly trackingNumber: string;
  /** The carrier row this shipment names, for an adapter that needs an account. */
  readonly carrierCode: string;
}

export interface CarrierAdapter {
  readonly code: string;
  /**
   * Whether there is anybody to ask. `false` is a first-class answer, not a
   * degraded one: a warehouse that types tracking numbers off a courier's paper
   * manifest is a real way to run, and the manual adapter is what it looks like.
   */
  readonly canPoll: boolean;
  fetchTracking(request: CarrierTrackingRequest): Promise<CarrierTrackingEvent[]>;
}

/**
 * Delay before each *retry*, in order. Attempt 1 is immediate, so the first
 * entry is the gap between attempt 1 and attempt 2.
 *
 * Far shorter than the outbound-webhook schedule in `webhooks/`, and for a
 * reason worth stating: that one is a background worker owning a durable row, so
 * it can afford to come back in six hours. This runs inside a request a person
 * is waiting on, so the whole ladder has to fit inside a request budget. A
 * carrier that is still refusing after these three attempts is an outage, and
 * the honest thing to do is dead-letter it and let the operator try again rather
 * than hold their browser open.
 */
export const CARRIER_RETRY_SCHEDULE_MS: readonly number[] = [250, 750];

/** Attempt 1 plus one per scheduled retry. */
export const CARRIER_MAX_ATTEMPTS = CARRIER_RETRY_SCHEDULE_MS.length + 1;

/**
 * Per-attempt timeout. A carrier that has not answered in five seconds is not
 * about to; and unbounded is not an option, because a socket a courier never
 * closes would hold a request handler open for as long as they felt like it.
 */
export const CARRIER_CALL_TIMEOUT_MS = 5_000;

export function nextCarrierAttemptDelayMs(attempts: number): number | null {
  if (attempts < 1) return 0;
  return CARRIER_RETRY_SCHEDULE_MS[attempts - 1] ?? null;
}

export function shouldDeadLetterCarrierCall(attempts: number): boolean {
  return attempts >= CARRIER_MAX_ATTEMPTS;
}

export interface CarrierAttemptPlan {
  readonly attempts: number;
  readonly retryInMs: number | null;
  readonly deadLettered: boolean;
}

/**
 * The next state of one carrier call, as a value.
 *
 * Pure and separate from the executor for the reason the webhook policy gives:
 * that a failure retries, that the schedule is walked in order, and that the
 * call stops being retryable at exactly the point the schedule runs out are the
 * properties a reader has to be able to check, and none of them is legible when
 * they are spread through the branches of a function that is also doing I/O.
 *
 * `terminal` is the escape hatch for a failure that will never succeed later —
 * the carrier saying "no such tracking number". Retrying that is a way of
 * turning one wrong answer into three.
 */
export function planCarrierAttempt(input: {
  readonly attempts: number;
  readonly ok: boolean;
  readonly terminal?: boolean;
}): CarrierAttemptPlan {
  const attempts = input.attempts + 1;
  if (input.ok) return { attempts, retryInMs: null, deadLettered: false };

  const delay = input.terminal ? null : nextCarrierAttemptDelayMs(attempts);
  if (delay === null || shouldDeadLetterCarrierCall(attempts)) {
    return { attempts, retryInMs: null, deadLettered: true };
  }
  return { attempts, retryInMs: delay, deadLettered: false };
}

export type CarrierCallResult<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | {
      readonly ok: false;
      readonly attempts: number;
      readonly reason: "timeout" | "error";
      readonly error: string;
      readonly deadLettered: true;
    };

/** A failure the caller has decided is not worth another attempt. */
export class TerminalCarrierError extends Error {}

class CarrierTimeoutError extends Error {}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function withTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  timer: (ms: number) => Promise<void>,
): Promise<T> {
  // Raced rather than aborted: an adapter is third-party code and cannot be
  // relied on to honour an AbortSignal. The losing promise is left to settle on
  // its own — its result is discarded, and swallowing its rejection here is what
  // stops a late failure surfacing as an unhandled rejection that kills the
  // process minutes after the request it belonged to has been answered.
  let timedOut = false;
  const attempt = work().catch((error: unknown) => {
    if (timedOut) return Promise.reject(new CarrierTimeoutError("discarded"));
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  });
  attempt.catch(() => undefined);

  const deadline = timer(timeoutMs).then(() => {
    timedOut = true;
    throw new CarrierTimeoutError(`carrier did not answer within ${timeoutMs}ms`);
  });
  deadline.catch(() => undefined);

  return Promise.race([attempt, deadline]);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs one carrier call under the timeout and the retry ladder above, and
 * reports a dead letter as a **value** rather than a throw.
 *
 * A value, because every caller of this has the same correct response to a
 * carrier being unreachable: carry on. The shipment shipped, the stock moved,
 * the customer's goods are on a van — none of that is in question because a
 * courier's API is down, and a thrown exception here would invite a caller to
 * roll something back that must not be rolled back.
 */
export async function runCarrierCall<T>(
  work: () => Promise<T>,
  options?: {
    readonly timeoutMs?: number;
    /** The backoff between attempts. */
    readonly sleep?: (ms: number) => Promise<void>;
    /**
     * The per-attempt deadline, separate from the backoff so a test can hold one
     * still while driving the other. Racing a real clock to assert a retry
     * ladder is how a suite starts failing on a loaded machine and nowhere else.
     */
    readonly timer?: (ms: number) => Promise<void>;
  },
): Promise<CarrierCallResult<T>> {
  const timeoutMs = options?.timeoutMs ?? CARRIER_CALL_TIMEOUT_MS;
  const sleep = options?.sleep ?? realSleep;
  const timer = options?.timer ?? realSleep;

  let attempts = 0;
  for (;;) {
    try {
      const value = await withTimeout(work, timeoutMs, timer);
      return { ok: true, value, attempts: attempts + 1 };
    } catch (failure) {
      const plan = planCarrierAttempt({
        attempts,
        ok: false,
        terminal: failure instanceof TerminalCarrierError,
      });
      attempts = plan.attempts;

      if (plan.deadLettered) {
        return {
          ok: false,
          attempts,
          reason: failure instanceof CarrierTimeoutError ? "timeout" : "error",
          error: describe(failure),
          deadLettered: true,
        };
      }
      await sleep(plan.retryInMs ?? 0);
    }
  }
}

/**
 * The in-app POST, as an adapter.
 *
 * `canPoll: false` and a `fetchTracking` that returns nothing is not a stub — it
 * is the accurate description of an organisation whose "integration" is a person
 * reading a courier's website. Making that a registered adapter rather than an
 * `if (!carrier) return` somewhere means the manual case and a real carrier take
 * the same path through `CarrierStatusService`, so the first real adapter cannot
 * quietly acquire a second set of rules.
 */
export const MANUAL_CARRIER_ADAPTER: CarrierAdapter = {
  code: "manual",
  canPoll: false,
  fetchTracking: () => Promise.resolve([]),
};

/**
 * Which adapter speaks for a carrier.
 *
 * Resolution is by the carrier's `code`, which is the tenant's own string and
 * therefore untrusted as a *route*: an unknown code resolves to the manual
 * adapter rather than throwing, so an organisation naming its courier "FEDEX"
 * gets manual tracking rather than a 500. Registration is the deliberate act —
 * an adapter exists because this file names it, never because a tenant typed
 * something.
 */
@Injectable()
export class CarrierAdapterRegistry {
  private readonly adapters = new Map<string, CarrierAdapter>();

  forCarrier(code: string | null | undefined): CarrierAdapter {
    if (!code) return MANUAL_CARRIER_ADAPTER;
    return this.adapters.get(code.trim().toUpperCase()) ?? MANUAL_CARRIER_ADAPTER;
  }

  /** Used by the boundary's tests, and by whichever real adapter ships first. */
  register(adapter: CarrierAdapter): void {
    this.adapters.set(adapter.code.trim().toUpperCase(), adapter);
  }
}
