import type { CarrierStatusInput } from "../dto/carrier-status.schemas";

/**
 * INV-26 — the seam a courier integration implements: book, label, track, and
 * the inbound half of the same relationship.
 *
 * ## Why this is separate from `carrier-adapter.ts`
 *
 * That file already owns the *polling* boundary — the retry ladder, the
 * per-attempt timeout, and the rule that a dead letter is a value rather than a
 * throw — and it is deliberately one method wide, because polling is all it was
 * asked to do. This port is the rest of the relationship: putting a consignment
 * on a courier's books, getting the piece of paper that goes on the carton, and
 * reading what the courier pushes back at us. It reuses `runCarrierCall` rather
 * than re-deriving a second retry policy, and it reuses `CarrierTrackingEvent`
 * so that a poll and a webhook cannot drift into two shapes of the same fact.
 *
 * ## What an adapter may not do
 *
 * The same rule, restated because it is the one that keeps stock correct: an
 * adapter never writes stock, and never writes a shipment row. It returns
 * values. `CarrierTransportService` decides what to do with them, and
 * `applyEvent` applies tracking under the dedupe and monotonicity rules it
 * already enforces. So an adapter that times out, throws, or lies cannot
 * corrupt internal stock, because stock posts on the internal ship command and
 * none of this code runs anywhere near it.
 *
 * ## Why `outcome` is three-way
 *
 * Taken from `accounting/compliance/transport`, for its reason. `rejected` is
 * the carrier reading the request and refusing it — nothing to retry until
 * something changes. `unavailable` is the carrier not answering, where the
 * request may be perfectly good. A boolean collapses the two, and then you
 * either retry a refusal forever or abandon a valid shipment on one timeout.
 */

/** The tenant's account with this courier, resolved and decrypted at the seam. */
export interface CarrierAccount {
  /** The tenant's own code for the courier. For the adapter's logs, not routing. */
  readonly carrierCode: string;
  /** Where this tenant's calls go — sandbox or production is their choice. */
  readonly baseUrl: string;
  /** Plaintext, for the length of one call. Never logged, never returned. */
  readonly credential: string;
}

/**
 * One carton, exactly as `inv_packages` stores it.
 *
 * The values are passed through verbatim, including the fact that the columns
 * declare no unit: `inv_packages.weight` is `numeric(18,4)` and says nowhere
 * whether a warehouse entered grams or kilograms. Guessing here would be a
 * silent hundredfold error on a courier invoice, so the guess is pushed to the
 * one place that can make it correctly — a real courier's adapter, which knows
 * what that courier expects and can be configured per tenant. `invCartonTypes`
 * is the declared-unit path (`inner_length_mm`, `max_weight_grams`) and is
 * where a future adapter should read from when a package names a carton type.
 */
export interface CarrierParcel {
  readonly reference: string;
  readonly declaredWeight: string | null;
  readonly declaredLength: string | null;
  readonly declaredWidth: string | null;
  readonly declaredHeight: string | null;
}

/**
 * What we ask a courier to carry.
 *
 * Deliberately small, and for the compliance port's reason: anything richer
 * would make this a second copy of the shipment, and the copy is what rots.
 */
export interface CarrierBookingRequest {
  /** Our shipment number. The courier's reference back to us. */
  readonly shipmentNumber: string;
  /** Free text, because that is what a sales order stores. */
  readonly destinationAddress: string | null;
  readonly destinationPin?: string | null;
  readonly destinationPhone?: string | null;
  readonly destinationName?: string | null;
  readonly originName?: string | null;
  readonly originAddress?: string | null;
  readonly originPin?: string | null;
  readonly originPhone?: string | null;
  readonly parcels: readonly CarrierParcel[];
}

/** What a courier gives back when it accepts a consignment. */
export interface CarrierBooking {
  /** The courier's own handle, needed to ask for a label later. */
  readonly carrierReference: string;
  /** What the customer will type into a tracking page. */
  readonly trackingNumber: string;
  /** Some couriers hand the label back with the booking; most do not. */
  readonly label: CarrierLabel | null;
}

export interface CarrierLabel {
  /** Where the label lives. Never rendered into a page unverified. */
  readonly url: string;
  /** `PDF` · `PNG` · `ZPL` — what the printer at the bench has to cope with. */
  readonly format: string;
}

export type CarrierTransportResult<T> =
  /** The courier took it. The only outcome that changes a shipment. */
  | { readonly outcome: "accepted"; readonly value: T }
  /** The courier read it and said no. Retrying changes nothing. */
  | {
      readonly outcome: "rejected";
      readonly errors: ReadonlyArray<{ readonly code: string; readonly message: string }>;
    }
  /** Unreachable, or an answer we could not read. The request may be fine. */
  | { readonly outcome: "unavailable"; readonly reason: string };

/**
 * Whether a callback really came from this tenant's courier.
 *
 * Carrier-specific, and on the adapter for that reason: every courier signs
 * differently, and inventing one scheme for all of them would be inventing it
 * for a courier whose documentation we have not read. The reference adapter
 * uses the house scheme in `webhooks/webhook-signature.ts`, which is timestamped
 * and therefore replay-bounded; a real courier's adapter brings its own.
 */
export type CarrierWebhookVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * A callback, read into our vocabulary.
 *
 * `eventKey` is the courier's own id for the event where it sends one. It is
 * the idempotency key, so it must come from material the signature covered —
 * never from a header, which a caller can vary freely against one captured
 * body. An adapter that has no id returns null and the receiver digests the
 * signed body instead.
 */
export interface CarrierWebhookEvent {
  readonly eventKey: string | null;
  readonly event: CarrierStatusInput;
}

export type CarrierWebhookParse =
  | { readonly ok: true; readonly value: CarrierWebhookEvent }
  | { readonly ok: false; readonly reason: string };

export interface CarrierTransportAdapter {
  /** The `inv_carriers.transport` value rows handled by this adapter carry. */
  readonly transport: string;
  /** Human name, for the operator's screen and for an honest empty state. */
  readonly name: string;
  /**
   * Whether this adapter speaks a courier's real wire format. `false` means it
   * speaks a shape this repository defined, so a booking it reports is a real
   * HTTP exchange with whatever is at `baseUrl` and is **not** evidence that a
   * courier has the parcel.
   */
  readonly isReal: boolean;

  book(
    account: CarrierAccount,
    request: CarrierBookingRequest,
  ): Promise<CarrierTransportResult<CarrierBooking>>;

  fetchLabel(
    account: CarrierAccount,
    carrierReference: string,
  ): Promise<CarrierTransportResult<CarrierLabel>>;

  track(
    account: CarrierAccount,
    trackingNumber: string,
  ): Promise<CarrierTransportResult<readonly CarrierStatusInput[]>>;

  verifyWebhook(input: {
    readonly secret: string;
    readonly rawBody: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): CarrierWebhookVerification;

  parseWebhook(rawBody: string): CarrierWebhookParse;
}
