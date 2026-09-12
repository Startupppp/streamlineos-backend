import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invCarriers, invShipments } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import {
  callCarrier,
  failureCode,
  failureMessage,
  toOperationResult,
  type CarrierOperationResult,
} from "../lib/carrier-call";
import { applyTrackingBatch, destinationForOrder, parcelsForShipment } from "../lib/carrier-request";
import {
  latestAcceptedBooking,
  listCarrierDeliveries,
  listCarrierOperations,
  recordCarrierOperation,
} from "../lib/carrier-operations";
import { resolveCarrierAccount } from "./carrier-credentials.service";
import { CarrierTransportRegistry } from "./carrier-transport.registry";
import type { CarrierDeliveriesQuery, CarrierOperationsQuery } from "../dto/carrier-transport.schemas";

export type { CarrierOperationResult };

/**
 * INV-26 — booking a consignment, fetching its label, and asking where it is.
 *
 * An adapter returns values; this decides what they mean. Nothing an adapter
 * says writes stock, and the only shipment column it can move is
 * `tracking_number`, which is the direct product of a booking — status still
 * moves only through `applyEvent`, under the dedupe and monotonic rules that
 * were already there, so a courier cannot tell us a parcel is delivered by
 * answering a booking call.
 *
 * Every path records an `inv_carrier_operations` row, because the ticket's
 * acceptance is that failure states are visible and a failed carrier call
 * changes nothing else: the shipment, the stock and the operator's screen are
 * all unchanged, so without the row the only evidence a courier refused a
 * booking at 06:00 is a log line, and a log line is not a work queue.
 */
@Injectable()
export class CarrierTransportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
    private readonly registry: CarrierTransportRegistry,
  ) {}

  /**
   * Put the consignment on the courier's books. Idempotent by construction
   * rather than by header: a shipment that already has an accepted booking
   * returns that booking instead of buying a second consignment, because a
   * courier will happily sell two labels for one parcel.
   */
  async book(orgId: string, userId: string, shipmentId: number): Promise<CarrierOperationResult> {
    const { shipment, carrier, adapter, account } = await this.prepare(orgId, shipmentId);

    const existing = await latestAcceptedBooking(this.db, orgId, shipmentId);
    if (existing?.carrierReference) {
      return {
        shipmentId,
        operation: "book",
        outcome: "accepted",
        // Zero attempts, because none were made. A reader can tell this answer
        // from a fresh booking that succeeded first time.
        attempts: 0,
        transport: adapter.transport,
        carrierReference: existing.carrierReference,
        trackingNumber: existing.trackingNumber,
        labelUrl: null,
        labelFormat: null,
        recorded: 0,
        message: null,
      };
    }

    const [parcels, destination] = await Promise.all([
      parcelsForShipment(this.db, orgId, shipmentId),
      destinationForOrder(this.db, orgId, shipment.soId),
    ]);
    const result = await callCarrier(() =>
      adapter.book(account, {
        shipmentNumber: shipment.shipmentNumber,
        destinationAddress: destination,
        parcels,
      }),
    );

    const booking = result.outcome === "accepted" ? result.value : null;
    await recordCarrierOperation(this.db, {
      orgId,
      carrierId: carrier.id,
      shipmentId,
      transport: adapter.transport,
      operation: "book",
      outcome: result.outcome,
      attempts: result.attempts,
      carrierReference: booking?.carrierReference ?? null,
      trackingNumber: booking?.trackingNumber ?? null,
      labelUrl: booking?.label?.url ?? null,
      labelFormat: booking?.label?.format ?? null,
      errorCode: failureCode(result),
      errorMessage: failureMessage(result),
      requestedBy: userId,
    });

    if (booking) {
      // The only shipment column a booking moves. The courier's number is
      // authoritative once it has the parcel, so it replaces whatever an
      // operator had typed from a paper manifest.
      await this.db
        .update(invShipments)
        .set({ trackingNumber: booking.trackingNumber })
        .where(and(eq(invShipments.orgId, orgId), eq(invShipments.id, shipmentId)));
      await this.audit.insert(this.db, {
        orgId,
        actorUserId: userId,
        action: "shipment.carrier-booked",
        resourceType: "shipment",
        resourceId: String(shipmentId),
        after: { carrier: adapter.transport, trackingNumber: booking.trackingNumber },
      });
    }

    return toOperationResult(shipmentId, "book", adapter.transport, result, {
      carrierReference: booking?.carrierReference ?? null,
      trackingNumber: booking?.trackingNumber ?? null,
      labelUrl: booking?.label?.url ?? null,
      labelFormat: booking?.label?.format ?? null,
    });
  }

  /**
   * Ask for the piece of paper that goes on the carton. Separate from booking
   * because most couriers generate a label asynchronously — so "the label never
   * came back" is a distinct, visible failure rather than a booking that
   * half-worked.
   */
  async fetchLabel(
    orgId: string,
    userId: string,
    shipmentId: number,
  ): Promise<CarrierOperationResult> {
    const { carrier, adapter, account } = await this.prepare(orgId, shipmentId);

    const booking = await latestAcceptedBooking(this.db, orgId, shipmentId);
    const carrierReference = booking?.carrierReference;
    if (!carrierReference) {
      throw new BadRequestException(
        "This shipment has no accepted carrier booking, so there is no label to fetch.",
      );
    }

    const result = await callCarrier(() => adapter.fetchLabel(account, carrierReference));
    const label = result.outcome === "accepted" ? result.value : null;

    await recordCarrierOperation(this.db, {
      orgId,
      carrierId: carrier.id,
      shipmentId,
      transport: adapter.transport,
      operation: "label",
      outcome: result.outcome,
      attempts: result.attempts,
      carrierReference,
      labelUrl: label?.url ?? null,
      labelFormat: label?.format ?? null,
      errorCode: failureCode(result),
      errorMessage: failureMessage(result),
      requestedBy: userId,
    });

    return toOperationResult(shipmentId, "label", adapter.transport, result, {
      carrierReference,
      trackingNumber: booking.trackingNumber,
      labelUrl: label?.url ?? null,
      labelFormat: label?.format ?? null,
    });
  }

  /** Ask the courier where the parcel is, and fold what it says into the shipment. */
  async track(orgId: string, userId: string, shipmentId: number): Promise<CarrierOperationResult> {
    const { shipment, carrier, adapter, account } = await this.prepare(orgId, shipmentId);
    const tracking = shipment.trackingNumber;
    if (!tracking) {
      throw new BadRequestException("This shipment has no tracking number to ask about.");
    }

    const result = await callCarrier(() => adapter.track(account, tracking));
    const recorded = await applyTrackingBatch(
      { db: this.db, audit: this.audit },
      orgId,
      userId,
      shipment,
      tracking,
      result.outcome === "accepted" ? result.value : [],
    );

    await recordCarrierOperation(this.db, {
      orgId,
      carrierId: carrier.id,
      shipmentId,
      transport: adapter.transport,
      operation: "track",
      outcome: result.outcome,
      attempts: result.attempts,
      trackingNumber: tracking,
      errorCode: failureCode(result),
      errorMessage: failureMessage(result),
      requestedBy: userId,
    });

    return {
      ...toOperationResult(shipmentId, "track", adapter.transport, result, {
        carrierReference: null,
        trackingNumber: tracking,
        labelUrl: null,
        labelFormat: null,
      }),
      recorded,
    };
  }

  operations(orgId: string, query: CarrierOperationsQuery) {
    return listCarrierOperations(this.db, orgId, query);
  }

  deliveries(orgId: string, query: CarrierDeliveriesQuery) {
    return listCarrierDeliveries(this.db, orgId, query);
  }

  /**
   * Everything a call needs, or the reason there is no call to make. Each
   * refusal is a 400 naming the missing half, not a 500 and not a recorded
   * "failure": a carrier nobody has finished configuring is an ordinary state
   * of a row created this morning, and the fix is on the carrier screen.
   */
  private async prepare(orgId: string, shipmentId: number) {
    const [row] = await this.db
      .select({
        id: invShipments.id,
        shipmentNumber: invShipments.shipmentNumber,
        status: invShipments.status,
        soId: invShipments.soId,
        carrierId: invShipments.carrierId,
        trackingNumber: invShipments.trackingNumber,
        carrierRowId: invCarriers.id,
        carrierCode: invCarriers.code,
        carrierTransport: invCarriers.transport,
        carrierApiBaseUrl: invCarriers.apiBaseUrl,
        carrierApiCredentialEncrypted: invCarriers.apiCredentialEncrypted,
        carrierWebhookSecretEncrypted: invCarriers.webhookSecretEncrypted,
      })
      .from(invShipments)
      .leftJoin(
        invCarriers,
        and(eq(invCarriers.orgId, orgId), eq(invCarriers.id, invShipments.carrierId)),
      )
      .where(and(eq(invShipments.orgId, orgId), eq(invShipments.id, shipmentId)))
      .limit(1);
    // 404 rather than 403 on a shipment in another tenant: a "forbidden" on
    // somebody else's id confirms the record exists.
    if (!row) throw new NotFoundException("Shipment not found");
    if (row.carrierRowId === null || row.carrierCode === null) {
      throw new BadRequestException("This shipment names no carrier.");
    }

    const carrier = {
      id: row.carrierRowId,
      code: row.carrierCode,
      transport: row.carrierTransport,
      apiBaseUrl: row.carrierApiBaseUrl,
      apiCredentialEncrypted: row.carrierApiCredentialEncrypted,
      webhookSecretEncrypted: row.carrierWebhookSecretEncrypted,
    };

    const adapter = this.registry.forTransport(carrier.transport);
    if (!adapter) {
      throw new BadRequestException(
        "This carrier has no transport configured, so there is nobody to ask. " +
          "Tracking for it is whatever an operator enters by hand.",
      );
    }

    const resolved = resolveCarrierAccount(carrier);
    if (!resolved.ok) throw new BadRequestException(resolved.reason);

    return { shipment: row, carrier, adapter, account: resolved.account };
  }
}
