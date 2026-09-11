import { Inject, Injectable, Optional } from "@nestjs/common";
import { z } from "zod";
import { verifyWebhookSignature } from "../../webhooks/webhook-signature";
import { carrierStatusSchema } from "../dto/carrier-status.schemas";
import {
  CARRIER_HTTP,
  defaultCarrierHttp,
  type CarrierHttp,
  type CarrierHttpResult,
} from "./carrier-http";
import type {
  CarrierAccount,
  CarrierBooking,
  CarrierBookingRequest,
  CarrierLabel,
  CarrierTransportAdapter,
  CarrierTransportResult,
  CarrierWebhookParse,
  CarrierWebhookVerification,
} from "./carrier-transport.port";
import type { CarrierStatusInput } from "../dto/carrier-status.schemas";

/**
 * INV-26 — one concrete adapter, and a plain statement of what it is.
 *
 * ## Which courier this is
 *
 * **None of them, yet, and that is a product decision rather than an
 * engineering gap.** `claude-packs/MODULE-PENDING-20260910.md` records the
 * order of work for this ticket and puts the choice first: "a decision on which
 * carrier ships first (Delhivery / Shiprocket / Bluedart — a product call, not
 * an engineering one)". Three couriers are named as candidates; none is named
 * as chosen, and no sandbox account exists for any of them.
 *
 * So this adapter speaks a JSON shape **this repository defined**, documented
 * below, and `isReal` is `false` to say so in code rather than in a deployment
 * note. What it is not is a stub: it makes real HTTP calls to whatever
 * `inv_carriers.api_base_url` names, reads real answers, and invents nothing.
 * A tracking number it reports is one the server at that URL returned. Nothing
 * here can mint a consignment that does not exist, which is the failure mode
 * INV-27 had to be rescued from.
 *
 * ## What changes when a courier is chosen
 *
 * This file. The five methods below are the whole carrier-specific surface —
 * request shapes, response shapes, status vocabulary, signature scheme — and
 * everything around them (retry ladder, dead letters, credential storage,
 * idempotency, the monotonic status rule) is courier-independent and already
 * built. A second adapter is a sibling of this file plus one line in the
 * registry; it does not touch the port, the service, the receiver or the
 * schema.
 *
 * ## The wire format, stated so it can be checked
 *
 *   POST {baseUrl}/shipments
 *     -> 2xx { consignmentId, trackingNumber, label?: { url, format } }
 *     -> 4xx { errors: [{ code, message }] }
 *   GET  {baseUrl}/shipments/{consignmentId}/label
 *     -> 2xx { url, format }
 *   GET  {baseUrl}/tracking/{trackingNumber}
 *     -> 2xx { events: [{ id, status, occurredAt, description? }] }
 *
 * The credential travels as `Authorization: Bearer <key>`, and callbacks are
 * signed with the house scheme in `webhooks/webhook-signature.ts` — timestamped,
 * so a captured callback stops verifying once the window passes.
 */

const labelSchema = z.object({
  url: z.string().url(),
  format: z.enum(["PDF", "PNG", "ZPL"]),
});

const bookingSchema = z.object({
  consignmentId: z.string().min(1).max(200),
  trackingNumber: z.string().min(1).max(200),
  label: labelSchema.nullish(),
});

const errorsSchema = z.object({
  errors: z.array(z.object({ code: z.string().max(100), message: z.string().max(500) })).min(1),
});

const trackingSchema = z.object({
  events: z.array(
    z.object({
      id: z.string().min(1).max(200).nullish(),
      status: carrierStatusSchema.shape.status,
      occurredAt: z.string().datetime(),
      description: z.string().max(500).nullish(),
    }),
  ),
});

const callbackSchema = z.object({
  eventId: z.string().min(1).max(200).nullish(),
  trackingNumber: z.string().min(1).max(200),
  status: carrierStatusSchema.shape.status,
  occurredAt: z.string().datetime(),
  description: z.string().max(500).nullish(),
});

/** The courier's own error list where it sent one, otherwise the bare status. */
function rejection(status: number, body: unknown): CarrierTransportResult<never> {
  const parsed = errorsSchema.safeParse(body);
  return {
    outcome: "rejected",
    errors: parsed.success
      ? parsed.data.errors
      : [{ code: `http_${status}`, message: `Carrier refused the request (HTTP ${status})` }],
  };
}

/**
 * The single place an HTTP answer becomes one of the three outcomes.
 *
 * 5xx and a transport failure are both `unavailable` because in both cases the
 * request may be perfectly good; only a 4xx is the courier having read it.
 */
function classify<T>(
  result: CarrierHttpResult,
  read: (body: unknown) => T | null,
): CarrierTransportResult<T> {
  if (!result.ok) return { outcome: "unavailable", reason: result.reason };
  if (result.status >= 500) {
    return { outcome: "unavailable", reason: `carrier returned HTTP ${result.status}` };
  }
  if (result.status >= 400) return rejection(result.status, result.body);

  const value = read(result.body);
  // A 2xx whose body we cannot read is not a rejection: the courier believes it
  // succeeded, and calling it rejected would invite a caller to book again.
  return value === null
    ? { outcome: "unavailable", reason: "carrier answered in a shape this adapter cannot read" }
    : { outcome: "accepted", value };
}

@Injectable()
export class ReferenceHttpCarrierAdapter implements CarrierTransportAdapter {
  readonly transport = "reference-http";
  readonly name = "Reference HTTP carrier (no courier is connected)";
  readonly isReal = false;

  private readonly http: CarrierHttp;

  constructor(@Optional() @Inject(CARRIER_HTTP) http?: CarrierHttp) {
    this.http = http ?? defaultCarrierHttp;
  }

  async book(
    account: CarrierAccount,
    request: CarrierBookingRequest,
  ): Promise<CarrierTransportResult<CarrierBooking>> {
    const result = await this.http.request({
      url: `${trimTrailingSlash(account.baseUrl)}/shipments`,
      method: "POST",
      credential: account.credential,
      body: {
        reference: request.shipmentNumber,
        destination: request.destinationAddress,
        parcels: request.parcels,
      },
    });

    return classify(result, (body) => {
      const parsed = bookingSchema.safeParse(body);
      if (!parsed.success) return null;
      return {
        carrierReference: parsed.data.consignmentId,
        trackingNumber: parsed.data.trackingNumber,
        label: parsed.data.label ?? null,
      };
    });
  }

  async fetchLabel(
    account: CarrierAccount,
    carrierReference: string,
  ): Promise<CarrierTransportResult<CarrierLabel>> {
    const result = await this.http.request({
      // The reference came from the courier, not from a caller, but it still
      // goes through the encoder: it lands in a path segment.
      url: `${trimTrailingSlash(account.baseUrl)}/shipments/${encodeURIComponent(carrierReference)}/label`,
      method: "GET",
      credential: account.credential,
    });

    return classify(result, (body) => {
      const parsed = labelSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    });
  }

  async track(
    account: CarrierAccount,
    trackingNumber: string,
  ): Promise<CarrierTransportResult<readonly CarrierStatusInput[]>> {
    const result = await this.http.request({
      url: `${trimTrailingSlash(account.baseUrl)}/tracking/${encodeURIComponent(trackingNumber)}`,
      method: "GET",
      credential: account.credential,
    });

    return classify(result, (body) => {
      const parsed = trackingSchema.safeParse(body);
      if (!parsed.success) return null;
      // The tracking number is ours, not the courier's echo of it: an adapter
      // that returned an event for a parcel we did not ask about would be
      // naming somebody else's shipment, and `refreshTracking` drops those.
      return parsed.data.events.map((event) => ({
        trackingNumber,
        status: event.status,
        occurredAt: event.occurredAt,
        ...(event.id ? { carrierEventId: event.id } : {}),
        ...(event.description ? { description: event.description } : {}),
      }));
    });
  }

  verifyWebhook(input: {
    readonly secret: string;
    readonly rawBody: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): CarrierWebhookVerification {
    const check = verifyWebhookSignature({
      secret: input.secret,
      header: input.headers["x-inventory-signature"],
      rawBody: input.rawBody,
    });
    return check.valid ? { valid: true } : { valid: false, reason: check.reason };
  }

  parseWebhook(rawBody: string): CarrierWebhookParse {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: "callback body is not JSON" };
    }

    const parsed = callbackSchema.safeParse(decoded);
    if (!parsed.success) return { ok: false, reason: "callback body is not a carrier event" };

    return {
      ok: true,
      value: {
        eventKey: parsed.data.eventId ?? null,
        event: {
          trackingNumber: parsed.data.trackingNumber,
          status: parsed.data.status,
          occurredAt: parsed.data.occurredAt,
          ...(parsed.data.eventId ? { carrierEventId: parsed.data.eventId } : {}),
          ...(parsed.data.description ? { description: parsed.data.description } : {}),
        },
      },
    };
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
