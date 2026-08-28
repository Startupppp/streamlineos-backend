import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { invShipments, invShipmentStatusEvents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
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

@Injectable()
export class CarrierStatusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
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
