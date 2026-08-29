import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { invCarriers, invShipments, invShipmentStatusEvents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { CarrierAdapterRegistry, runCarrierCall } from "./carrier-adapter";
import type { CarrierStatusInput } from "./dto/carrier-status.schemas";

/**
 * How far along a shipment is. A carrier may move a shipment forward through
 * this order; it may never move one back.
 *
 * The reason is that carrier events arrive out of order routinely -- an
 * OUT_FOR_DELIVERY scan lands after the DELIVERED scan often enough that any
 * system taking the latest message as truth will regularly tell a customer
 * their delivered parcel is back on a van. The event is still *recorded*; it
 * simply does not move the shipment.
 */
const PROGRESS: Record<string, number> = {
  DRAFT: 0,
  PACKED: 1,
  LABEL_CREATED: 2,
  SHIPPED: 3,
  DELIVERED: 4,
};

/**
 * CANCELLED is deliberately absent from the ladder above.
 *
 * It is a terminal side branch, not a further stage: a parcel is not "more
 * delivered than delivered" because the label was later voided. Ranking it
 * highest -- as this did -- meant a late cancellation webhook overwrote a
 * delivered shipment and then froze it there, because nothing outranks the top,
 * so no subsequent event could correct it. The monotonic rule the file exists
 * to enforce was defeated by its own ordering.
 *
 * A cancellation is accepted only while the goods have not arrived. After
 * delivery it is recorded like any other late event and changes nothing.
 */

/** What a shipment refresh did, as a value the UI can render verbatim. */
export interface CarrierRefreshResult {
  shipmentId: number;
  carrier: string;
  /** False when there is nobody to ask — the manual adapter's normal answer. */
  polled: boolean;
  /** Events the carrier returned that we had not already recorded. */
  recorded: number;
  status: string;
  deadLettered: boolean;
  /** Present only on a dead letter, for an operator reading a log. */
  error?: string;
}

@Injectable()
export class CarrierStatusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
    private readonly adapters: CarrierAdapterRegistry,
  ) {}

  /**
   * INV-207 — accept a carrier's account of a shipment.
   *
   * Three rules, each of which exists because carriers routinely break the
   * assumption it protects:
   *
   *   **Replay is a no-op.** The same event id arrives more than once as a
   *   matter of course. `ON CONFLICT DO NOTHING` against the partial unique
   *   index makes that free and race-proof; a read-then-write check would let
   *   two simultaneous deliveries both pass.
   *
   *   **Time runs forward only.** An event that would move the shipment
   *   backwards is stored and ignored, because the record of what the carrier
   *   claimed is worth keeping even when we decline to act on it.
   *
   *   **The carrier does not get to say who it is about.** The shipment is
   *   resolved from our own tracking number within the caller's tenant, never
   *   from an id in the payload. Otherwise a webhook could name any shipment in
   *   any organisation.
   */
  async recordEvent(orgId: string, userId: string, input: CarrierStatusInput) {
    const shipment = await this.db.query.invShipments.findFirst({
      where: and(
        eq(invShipments.orgId, orgId),
        eq(invShipments.trackingNumber, input.trackingNumber),
      ),
      columns: { id: true, status: true, carrierId: true },
    });
    if (!shipment) {
      throw new NotFoundException("No shipment carries that tracking number");
    }
    return this.applyEvent(orgId, userId, shipment, input);
  }

  /**
   * B7, item 2 — ask the carrier where this parcel is, through the adapter
   * contract.
   *
   * Every answer this can give is a value, including "the courier is down".
   * Nothing here may throw at a caller who has already shipped goods: the stock
   * left the building on the internal ship command and a courier's API being
   * unreachable does not un-ship it. That is B7's item 3 stated as code rather
   * than as a promise.
   *
   * With no real adapter registered this reports `polled: false` and changes
   * nothing, which is the truthful description of manual tracking and is what
   * the shipment sheet renders instead of "coming soon".
   */
  async refreshTracking(
    orgId: string,
    userId: string,
    shipmentId: number,
  ): Promise<CarrierRefreshResult> {
    const [shipment] = await this.db
      .select({
        id: invShipments.id,
        status: invShipments.status,
        carrierId: invShipments.carrierId,
        trackingNumber: invShipments.trackingNumber,
        carrierCode: invCarriers.code,
      })
      .from(invShipments)
      .leftJoin(
        invCarriers,
        and(eq(invCarriers.orgId, orgId), eq(invCarriers.id, invShipments.carrierId)),
      )
      .where(and(eq(invShipments.orgId, orgId), eq(invShipments.id, shipmentId)))
      .limit(1);
    if (!shipment) throw new NotFoundException("Shipment not found");

    const adapter = this.adapters.forCarrier(shipment.carrierCode);
    const base = {
      shipmentId,
      carrier: adapter.code,
      status: shipment.status,
      deadLettered: false,
    };

    // No tracking number is not an error either. A shipment handed to a driver
    // before the courier has issued one is an ordinary morning in a warehouse.
    const tracking = shipment.trackingNumber;
    if (!adapter.canPoll || !tracking) {
      return { ...base, polled: false, recorded: 0 };
    }

    const call = await runCarrierCall(() =>
      adapter.fetchTracking({
        trackingNumber: tracking,
        carrierCode: shipment.carrierCode ?? adapter.code,
      }),
    );

    if (!call.ok) {
      // Dead letters are worth an audit row precisely because nothing else
      // records them: the shipment is unchanged, so without this the only
      // evidence a courier was unreachable is a log line nobody keeps.
      await this.audit.insert(this.db, {
        orgId,
        actorUserId: userId,
        action: "shipment.carrier-poll-dead-lettered",
        resourceType: "shipment",
        resourceId: String(shipmentId),
        metadata: {
          carrier: adapter.code,
          attempts: call.attempts,
          reason: call.reason,
          error: call.error,
        },
      });
      return { ...base, polled: true, recorded: 0, deadLettered: true, error: call.error };
    }

    let recorded = 0;
    let status: string = shipment.status;
    for (const event of call.value) {
      // The carrier's own account of which parcel this is, checked against ours
      // rather than trusted: an adapter that returns an event for a tracking
      // number we did not ask about is naming somebody else's shipment.
      if (event.trackingNumber !== tracking) continue;
      // Carried forward rather than read once. A poll returns a *batch*, and
      // carriers batch them in whatever order their queue drained — so applying
      // each against the status the shipment had before the batch started would
      // let a DELIVERED followed by an OUT-OF-ORDER earlier scan walk the
      // shipment backwards, which is the one thing the monotonic rule exists to
      // stop.
      const applied = await this.applyEvent(
        orgId,
        userId,
        { id: shipment.id, status, carrierId: shipment.carrierId },
        event,
      );
      if (applied.recorded) recorded += 1;
      status = applied.status;
    }

    return { ...base, polled: true, recorded, status };
  }

  /**
   * The dedupe and monotonicity rules, in one place.
   *
   * Shared by the in-app POST and by anything an adapter returns, so a real
   * carrier integration cannot quietly acquire a second set of rules — and so
   * the properties `carrier-status.seeded-e2e-spec.ts` pins hold for both.
   */
  private async applyEvent(
    orgId: string,
    userId: string,
    shipment: { id: number; status: string; carrierId: number | null },
    input: CarrierStatusInput,
  ) {
    const currentRank = PROGRESS[shipment.status] ?? 0;
    const cancelling = input.status === "CANCELLED";
    const incomingRank = cancelling ? null : PROGRESS[input.status];
    if (!cancelling && incomingRank === undefined) {
      throw new BadRequestException(`Unsupported status ${input.status}`);
    }

    const inserted = await this.db
      .insert(invShipmentStatusEvents)
      .values({
        orgId,
        shipmentId: shipment.id,
        carrierId: shipment.carrierId ?? null,
        status: input.status,
        occurredAt: new Date(input.occurredAt),
        carrierEventId: input.carrierEventId ?? null,
        description: input.description ?? null,
        rawPayload: input.rawPayload ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: invShipmentStatusEvents.id });

    // Nothing inserted means this exact carrier event has already been
    // recorded. Reporting that plainly beats pretending it was new.
    if (inserted.length === 0) {
      return { recorded: false, advanced: false, status: shipment.status };
    }

    // A cancellation applies only before the goods arrive; a delivered parcel
    // stays delivered whatever the carrier's billing system says afterwards.
    const advanced = cancelling
      ? shipment.status !== "DELIVERED" && shipment.status !== "CANCELLED"
      : (incomingRank ?? 0) > currentRank;
    if (advanced) {
      await this.db
        .update(invShipments)
        .set({
          status: input.status,
          ...(input.status === "DELIVERED"
            ? { deliveredAt: new Date(input.occurredAt) }
            : {}),
        })
        .where(and(eq(invShipments.orgId, orgId), eq(invShipments.id, shipment.id)));

      await this.audit.insert(this.db, {
        orgId,
        actorUserId: userId,
        action: "shipment.carrier-status",
        resourceType: "shipment",
        resourceId: String(shipment.id),
        after: { status: input.status, occurredAt: input.occurredAt },
      });
    }

    return {
      recorded: true,
      advanced,
      status: advanced ? input.status : shipment.status,
    };
  }

  /** The journey, newest first. */
  async timeline(orgId: string, shipmentId: number) {
    const shipment = await this.db.query.invShipments.findFirst({
      where: and(eq(invShipments.orgId, orgId), eq(invShipments.id, shipmentId)),
      columns: { id: true, status: true, trackingNumber: true },
    });
    if (!shipment) throw new NotFoundException("Shipment not found");

    const events = await this.db
      .select({
        id: invShipmentStatusEvents.id,
        status: invShipmentStatusEvents.status,
        occurredAt: invShipmentStatusEvents.occurredAt,
        receivedAt: invShipmentStatusEvents.receivedAt,
        description: invShipmentStatusEvents.description,
      })
      .from(invShipmentStatusEvents)
      .where(
        and(
          eq(invShipmentStatusEvents.orgId, orgId),
          eq(invShipmentStatusEvents.shipmentId, shipmentId),
        ),
      )
      .orderBy(desc(invShipmentStatusEvents.occurredAt))
      .limit(100);

    return { shipment, events };
  }
}
