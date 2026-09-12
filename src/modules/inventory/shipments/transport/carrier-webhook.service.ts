import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  invCarriers,
  invCarrierWebhookDeliveries,
  invShipments,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { applyEvent } from "../lib/carrier-events";
import { truncateCarrierMessage } from "../lib/carrier-operations";
import { carrierWebhookSecret } from "./carrier-credentials.service";
import { CarrierTransportRegistry } from "./carrier-transport.registry";

/**
 * INV-26 — a courier telling us where a parcel got to.
 *
 * Modelled on `billing/payments/payment-webhook-receiver.service.ts` rather
 * than invented: the tenant comes from the URL and is *proved* by the
 * signature, the answer is a `{ status, body }` value rather than a thrown
 * exception, and every failure mode has a distinct status so the courier's own
 * retry logic can tell "try again" from "stop".
 *
 * ## Four rules, each defending something a courier routinely breaks
 *
 * **Verification first, and a failed one opens nothing.** The route is public.
 * If a bad signature could insert a delivery row, anyone who can reach the URL
 * could fill the table. So a verification failure updates two columns on the
 * carrier row that already exists — bounded, and still visible on the carrier
 * screen — and answers 401.
 *
 * **The tenant is named by the URL and proved by the signature.** The org id in
 * the path only selects which secret to check against; an attacker naming
 * another organisation has to sign with that organisation's secret, which is
 * the point. Nothing in the payload is allowed to name a tenant.
 *
 * **Replay applies once.** `(org_id, carrier_id, event_key)` is a unique index
 * and the insert is `ON CONFLICT DO NOTHING`. Nothing inserted means this exact
 * event is already recorded, and the receiver returns without applying. A
 * read-then-write check would let two simultaneous redeliveries both pass.
 *
 * **The courier does not get to say which shipment.** The shipment is resolved
 * from our own tracking number inside the proved tenant, never from an id in
 * the payload — otherwise a callback could name any shipment in any
 * organisation. A tracking number we do not hold is a dead letter with a reason
 * an operator can read, not a dropped request.
 *
 * The whole ingest runs in one tenant transaction so the delivery row and the
 * event it applies commit together. Claiming `applied` and then failing to
 * apply would be the worst of both: the courier's retry would dedupe against a
 * row describing work that never happened.
 */
@Injectable()
export class CarrierWebhookReceiverService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
    private readonly registry: CarrierTransportRegistry,
  ) {}

  async receive(params: {
    readonly orgId: string;
    readonly carrierCode: string;
    readonly rawBody: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    return runInTenantTransaction(
      this.db,
      async () => this.ingest(params),
      { orgId: params.orgId },
    );
  }

  private async ingest(params: {
    readonly orgId: string;
    readonly carrierCode: string;
    readonly rawBody: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    const [carrier] = await this.db
      .select({
        id: invCarriers.id,
        code: invCarriers.code,
        transport: invCarriers.transport,
        apiBaseUrl: invCarriers.apiBaseUrl,
        apiCredentialEncrypted: invCarriers.apiCredentialEncrypted,
        webhookSecretEncrypted: invCarriers.webhookSecretEncrypted,
      })
      .from(invCarriers)
      .where(and(eq(invCarriers.orgId, params.orgId), eq(invCarriers.code, params.carrierCode)))
      .limit(1);
    // Deliberately the same 404 for "no such organisation" and "no such
    // carrier": an unauthenticated caller must not be able to enumerate either.
    if (!carrier) return { status: 404, body: { ok: false, error: "carrier not configured" } };

    const adapter = this.registry.forTransport(carrier.transport);
    if (!adapter) return { status: 400, body: { ok: false, error: "carrier has no transport" } };

    const secret = carrierWebhookSecret(carrier);
    if (!secret) return { status: 400, body: { ok: false, error: "webhook not configured" } };

    const verified = adapter.verifyWebhook({
      secret,
      rawBody: params.rawBody,
      headers: params.headers,
    });
    if (!verified.valid) {
      await this.recordVerificationFailure(params.orgId, carrier.id, verified.reason);
      return { status: 401, body: { ok: false, error: "invalid signature" } };
    }

    const parsed = adapter.parseWebhook(params.rawBody);
    if (!parsed.ok) {
      // Verified but unreadable. That is the courier changing its payload shape
      // under us, which is exactly the thing a dead letter is for: it is
      // genuine, it cannot be applied, and somebody has to look at it.
      return this.deadLetter(params, carrier.id, digest(params.rawBody), null, parsed.reason);
    }

    const event = parsed.value.event;
    const eventKey = parsed.value.eventKey ?? digest(params.rawBody);
    const payload: Record<string, unknown> = {
      trackingNumber: event.trackingNumber,
      status: event.status,
      occurredAt: event.occurredAt,
    };

    const [shipment] = await this.db
      .select({ id: invShipments.id, status: invShipments.status, carrierId: invShipments.carrierId })
      .from(invShipments)
      .where(
        and(
          eq(invShipments.orgId, params.orgId),
          eq(invShipments.trackingNumber, event.trackingNumber),
        ),
      )
      .limit(1);

    if (!shipment) {
      return this.deadLetter(
        params,
        carrier.id,
        eventKey,
        payload,
        `No shipment in this organisation carries tracking number ${event.trackingNumber}.`,
      );
    }

    const claimed = await this.claim({
      orgId: params.orgId,
      carrierId: carrier.id,
      eventKey,
      status: "applied",
      reason: null,
      trackingNumber: event.trackingNumber,
      shipmentId: shipment.id,
      payload,
    });
    // Already recorded. The courier is redelivering, which is normal, and
    // applying it a second time is exactly what the unique index prevents.
    if (!claimed) return { status: 200, body: { ok: true, duplicate: true } };

    // `applyEvent` owns dedupe by the courier's own event id and the monotonic
    // rule that a shipment never moves backwards. A callback arriving after
    // DELIVERED is still stored there and still changes nothing.
    const applied = await applyEvent(
      { db: this.db, audit: this.audit },
      params.orgId,
      // No user: a courier's callback is nobody's action, and inventing an
      // actor would put a person's name on something they did not do. The
      // audit column is a nullable FK to `users`, so null is the only value
      // that is both true and insertable.
      null,
      shipment,
      event,
    );

    return {
      status: 200,
      body: { ok: true, applied: applied.advanced, status: applied.status },
    };
  }

  /** A verified callback that cannot be applied, kept where somebody looks. */
  private async deadLetter(
    params: { readonly orgId: string },
    carrierId: number,
    eventKey: string,
    payload: Record<string, unknown> | null,
    reason: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const claimed = await this.claim({
      orgId: params.orgId,
      carrierId,
      eventKey,
      status: "dead_lettered",
      reason: truncateCarrierMessage(reason),
      trackingNumber: typeof payload?.trackingNumber === "string" ? payload.trackingNumber : null,
      shipmentId: null,
      payload,
    });
    // 202, not 4xx: the callback was genuine and we have kept it. Answering an
    // error would make the courier retry a delivery that will fail identically
    // every time, and some couriers disable an endpoint that keeps refusing.
    return {
      status: 202,
      body: { ok: true, deadLettered: true, ...(claimed ? {} : { duplicate: true }) },
    };
  }

  /**
   * The idempotency gate. Returns false when this event is already recorded.
   *
   * `onConflictDoNothing` against `uniq_inv_carrier_webhook_deliveries_event`
   * rather than a read-then-write check, so two simultaneous redeliveries of
   * one event cannot both pass.
   */
  private async claim(values: {
    orgId: string;
    carrierId: number;
    eventKey: string;
    status: "applied" | "dead_lettered" | "ignored";
    reason: string | null;
    trackingNumber: string | null;
    shipmentId: number | null;
    payload: Record<string, unknown> | null;
  }): Promise<boolean> {
    const inserted = await this.db
      .insert(invCarrierWebhookDeliveries)
      .values(values)
      .onConflictDoNothing({
        target: [
          invCarrierWebhookDeliveries.orgId,
          invCarrierWebhookDeliveries.carrierId,
          invCarrierWebhookDeliveries.eventKey,
        ],
      })
      .returning({ id: invCarrierWebhookDeliveries.id });
    return inserted.length > 0;
  }

  private async recordVerificationFailure(
    orgId: string,
    carrierId: number,
    reason: string,
  ): Promise<void> {
    await this.db
      .update(invCarriers)
      .set({ webhookLastFailureAt: new Date(), webhookFailureReason: reason })
      .where(and(eq(invCarriers.orgId, orgId), eq(invCarriers.id, carrierId)));
  }
}

/**
 * The idempotency key when the courier sends no event id of its own.
 *
 * Taken from the signed body, never from a header: the signature covers the
 * body alone, so a header is unsigned input that a caller holding one captured
 * body can vary at will. When a header was the key in the billing receiver, N
 * forged headers over one signed body opened N rows.
 */
function digest(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}
