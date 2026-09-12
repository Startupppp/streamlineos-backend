import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  invAsnLines,
  invAsns,
  invPurchaseOrders,
} from "../../../../../db/schema";
import { type Db } from "../../../../../db/drizzle.module";
import type { AsnDetail } from "./quick-commerce-documents";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
import { InventorySettingsService } from "../../../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../../../stock-engine/inventory-audit.service";
import { NumberSequenceService } from "../../../stock-engine/number-sequence.service";
import { WarehouseScopeService } from "../../../stock-engine/warehouse-scope.service";
import { DockService } from "../../../dock/dock.service";
import { runIdempotent } from "../../../stock-engine/idempotency";
import type { CreateAsnInput } from "../dto/quick-commerce.schemas";

/**
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and every caller stay unchanged, and nothing
 * here opens a transaction the service did not.
 *
 * `reloadUnscopedPo` is a CALLBACK rather than an imported read, deliberately.
 * `detailUnscoped` is the read that skips `platformPoInScope`, and its comment
 * on the service says it is "named so nobody routes to it by accident";
 * exporting it from `lib/` would make it importable from anywhere. Handing this
 * flow a bound closure keeps the ungated read private to the service, which is
 * the only place that has already asserted the caller's warehouse.
 */
export interface QcAsnDeps {
  readonly db: Db;
  readonly settings: InventorySettingsService;
  readonly audit: InventoryAuditService;
  readonly numSeq: NumberSequenceService;
  readonly warehouseScope: WarehouseScopeService;
  readonly dock: DockService;
  readonly reloadUnscopedAsn: (orgId: string, asnId: number) => Promise<AsnDetail>;
}

/**
 * Announce a shipment against a purchase order.
 *
 * An ASN moves no stock. It is the document the dock plans against, and the
 * thing `asnRequiredForGrn` makes receiving depend on — so it is created and
 * confirmed here, and consumed by the GRN path.
 */
export async function createAsn(deps: QcAsnDeps, orgId: string, userId: string, input: CreateAsnInput, idempotencyKey: string) {
  const [po] = await deps.db
    .select({ id: invPurchaseOrders.id, warehouseId: invPurchaseOrders.warehouseId })
    .from(invPurchaseOrders)
    .where(and(eq(invPurchaseOrders.orgId, orgId), eq(invPurchaseOrders.id, input.poId)));
  if (!po) throw new NotFoundException("Not found");

  const warehouseId = input.warehouseId ?? po.warehouseId ?? null;
  await deps.warehouseScope.assertWarehouseVisible(orgId, userId, warehouseId ?? undefined);

  const asnId = await deps.db.transaction((tx) =>
    runIdempotent(
      tx,
      orgId,
      idempotencyKey,
      { command: "inventory.asn.create", poId: input.poId, lines: input.lines },
      async () => {
        const asnNumber = await deps.numSeq.next(orgId, "ASN", tx);
        const [asn] = await tx
          .insert(invAsns)
          .values({
            orgId,
            asnNumber,
            platformPoId: input.platformPoId ?? null,
            poId: input.poId,
            warehouseId,
            locationId: input.locationId ?? null,
            status: "CONFIRMED",
            carrierName: input.carrierName ?? null,
            trackingRef: input.trackingRef ?? null,
            appointmentStart: input.appointmentStart ? new Date(input.appointmentStart) : null,
            appointmentEnd: input.appointmentEnd ? new Date(input.appointmentEnd) : null,
            expectedArrival: input.expectedArrival ?? null,
            notes: input.notes ?? null,
            createdBy: userId,
          })
          .returning();

        await tx.insert(invAsnLines).values(
          input.lines.map((line, index) => ({
            orgId,
            asnId: asn!.id,
            poLineId: line.poLineId ?? null,
            productVariantId: line.productVariantId,
            quantityExpected: line.quantityExpected,
            lotNumber: line.lotNumber ?? null,
            expiryDate: line.expiryDate ?? null,
            mrpPaise: line.mrpPaise ?? null,
            lineOrder: index,
          })),
        );

        await deps.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "asn.create",
          resourceType: "inv_asn",
          resourceId: String(asn!.id),
          after: { asnNumber, poId: input.poId, lineCount: input.lines.length },
        });

        return { asnId: asn!.id };
      },
      (stored) => stored as { asnId: number },
    ),
  );

  return deps.reloadUnscopedAsn(orgId, asnId.asnId);
}

/**
 * The gate `inv_settings.asn_required_for_grn` turns on.
 *
 * Called by the GRN draft path rather than living there, so the rule has one
 * home: a receipt may not be raised against a purchase order nobody announced.
 * Off by default, because most warehouses receive against a purchase order and
 * nothing else, and demanding an ASN they do not raise would stop receiving.
 */
export async function assertReceivable(
  deps: QcAsnDeps,
  tx: Tx,
  orgId: string,
  params: { poId: number; asnId: number | null },
): Promise<void> {
  const settings = await deps.settings.get(orgId);
  if (!settings.asnRequiredForGrn) return;

  if (params.asnId === null) {
    const [any] = await tx
      .select({ id: invAsns.id })
      .from(invAsns)
      .where(
        and(
          eq(invAsns.orgId, orgId),
          eq(invAsns.poId, params.poId),
          sql`${invAsns.status} IN ('CONFIRMED', 'IN_TRANSIT', 'ARRIVED')`,
        ),
      );
    if (!any) {
      throw new BadRequestException(
        "This organisation requires an advance shipping notice before a delivery can be received",
      );
    }
    return;
  }

  const [asn] = await tx
    .select({
      id: invAsns.id,
      poId: invAsns.poId,
      status: invAsns.status,
      appointmentStart: invAsns.appointmentStart,
    })
    .from(invAsns)
    .where(and(eq(invAsns.orgId, orgId), eq(invAsns.id, params.asnId)));
  if (!asn) throw new NotFoundException("Not found");
  if (asn.poId !== params.poId) {
    throw new BadRequestException("That advance shipping notice belongs to a different purchase order");
  }
  if (asn.status === "CANCELLED" || asn.status === "CLOSED") {
    throw new BadRequestException(`That advance shipping notice is ${asn.status.toLowerCase()}`);
  }

  // NEO-12. Where the organisation demands an announced delivery, it also
  // demands a slot: an ASN with no appointment is a lorry nobody expected at a
  // door nobody freed. The window on the ASN itself counts, and so does a dock
  // appointment booked against it — the two are the same statement made in
  // different places, and refusing one because the other was used would be a
  // rule about our data model rather than about the dock.
  const hasSlot =
    asn.appointmentStart !== null || (await deps.dock.hasAppointmentForAsn(orgId, asn.id));
  if (!hasSlot) {
    throw new BadRequestException(
      "This organisation requires an announced delivery to have a dock slot before it can be received",
    );
  }
}
