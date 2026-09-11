import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { invShipments, invShipmentStatusEvents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { CarrierAdapterRegistry } from "./carrier-adapter";
import {
  applyEvent,
  refreshTracking,
  type CarrierEventDeps,
} from "./lib/carrier-events";
import type { CarrierStatusInput } from "./dto/carrier-status.schemas";
import type { CarrierRefreshResult } from "./lib/carrier-events";

export type { CarrierRefreshResult };

/** What a shipment refresh did, as a value the UI can render verbatim. */

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
    return applyEvent(this.carrierDeps, orgId, userId, shipment, input);
  }

  /** The journey, newest first. */
  /** @see lib/carrier-events.ts */
  async refreshTracking(
    orgId: string,
    userId: string,
    shipmentId: number,
  ): Promise<CarrierRefreshResult> {
    return refreshTracking(this.carrierDeps, orgId, userId, shipmentId);
  }

  private get carrierDeps(): CarrierEventDeps {
    return { db: this.db, audit: this.audit, adapters: this.adapters };
  }

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
