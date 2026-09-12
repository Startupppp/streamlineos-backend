import { and, eq } from "drizzle-orm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  invPickLists,
  invPickListLines,
  invSalesOrders,
} from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import type { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import type { StockProjectionService } from "../../stock-engine/stock-projection.service";
import type { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import { runIdempotent } from "../../stock-engine/idempotency";
import { addDec, cmpDec } from "../../stock-engine/decimal";
import type { PickSoInput } from "../dto/inv-sales-orders.schemas";

export function revivePickResult(stored: unknown): {
  pickListId: number;
  pickNumber: string;
  allPicked: boolean;
} {
  const row = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  return {
    pickListId: Number(row.pickListId ?? 0),
    pickNumber: String(row.pickNumber ?? ""),
    allPicked: row.allPicked === true,
  };
}

/**
 * The two middle steps of fulfilment — picking a sales order and packing it —
 * lifted out of `so-fulfillment.service.ts` unchanged.
 *
 * Functions over a deps bag rather than a second `@Injectable`, the shape
 * `so-ship.ts` established in this very folder: the DI graph and every caller
 * stay unchanged, and the transaction stays owned by the service that opens it.
 */
export interface FulfilmentDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly numSeq: NumberSequenceService;
  readonly projection: StockProjectionService;
  readonly settingsService: InventorySettingsService;
}

  /**
   * A3. Picking took no idempotency key and ran across three separate
   * transactions — a pick-list insert, then a transaction for the projection,
   * then a line insert, then a status update.
   *
   * So a retry produced a *second* pick list, recorded the same pick again and
   * subtracted the same units from availability twice; and a failure between any
   * two of those steps left the order in a state no single step describes —
   * `outgoing_qty` moved with no lines to explain it, or lines with the bucket
   * untouched. One transaction, claimed once.
   */
export async function pickSo(
    deps: FulfilmentDeps,
    orgId: string,
    soId: number,
    userId: string,
    data: PickSoInput,
    idempotencyKey: string,
  ) {
    const so = await deps.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: { lines: { with: { productVariant: { with: { product: { columns: { id: true, trackingMethod: true } } } } } } },
    });
    if (!so) throw new NotFoundException("Sales order not found");

    for (const pickLine of data.lines) {
      const soLine = so.lines.find((l) => l.id === pickLine.soLineId);
      if (!soLine) throw new BadRequestException(`SO line ${pickLine.soLineId} not found`);

      const trackingMethod = soLine.productVariant.product.trackingMethod;
      if (trackingMethod === "SERIAL") {
        if (!pickLine.serialId) {
          throw new BadRequestException(`SO line ${pickLine.soLineId}: SERIAL-tracked product requires serialId per unit`);
        }
      }
    }

    // Exact. Deciding a whole order is picked on the strength of float
    // comparisons is how an order ships one unit short and nothing notices.
    const orderedQtyMap = new Map(so.lines.map((l) => [l.id, String(l.quantity)]));
    const pickedMap = new Map<number, string>();
    for (const line of data.lines) {
      pickedMap.set(
        line.soLineId,
        addDec(pickedMap.get(line.soLineId) ?? "0", line.quantityPicked),
      );
    }
    const allPicked = so.lines.every(
      (l) => cmpDec(pickedMap.get(l.id) ?? "0", orderedQtyMap.get(l.id) ?? "0") >= 0,
    );

    const result = await deps.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.sales-orders.pick", soId, lines: data.lines },
        async () => {
          // T04. This guard used to sit in front of `runIdempotent`, where pick's own
          // effect invalidated it: a full pick sets PICKED, and the retry was refused
          // with "must be CONFIRMED or RESERVED to pick" — on the status its own first
          // run had set — without reaching the guard that would have replayed the pick
          // list. This controller carries no `@Idempotent`, so nothing shadowed it.
          // Read through `tx` so the check sees the same snapshot the write does.
          const [current] = await tx
            .select({ status: invSalesOrders.status })
            .from(invSalesOrders)
            .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)))
            .limit(1);
          if (!current) throw new NotFoundException("Sales order not found");
          if (
            current.status !== "RESERVED" &&
            current.status !== "PARTIALLY_RESERVED" &&
            current.status !== "CONFIRMED"
          ) {
            throw new BadRequestException("Sales order must be CONFIRMED or RESERVED to pick");
          }

          const pickNumber = await deps.numSeq.next(orgId, "PICK_LIST", tx);

          const [pickList] = await tx.insert(invPickLists).values({
            orgId,
            pickNumber,
            soId,
            warehouseId: so.warehouseId,
            status: "COMPLETED",
            createdBy: userId,
          }).returning();

          await tx.insert(invPickListLines).values(
            data.lines.map((line) => {
              const soLine = so.lines.find((l) => l.id === line.soLineId);
              if (!soLine) throw new BadRequestException(`SO line ${line.soLineId} not found`);
              return {
                orgId,
                pickListId: pickList!.id,
                soLineId: line.soLineId,
                productVariantId: soLine.productVariantId,
                locationId: line.locationId,
                lotId: line.lotId,
                serialId: line.serialId,
                quantityToPick: line.quantityPicked,
                quantityPicked: line.quantityPicked,
              };
            })
          );

          // A1. `outgoing_qty` had no writer at all, so availability ignored one
          // of its five terms. Recomputed from the pick lines rather than
          // incremented, and at the row's full grain: the earlier version
          // matched (variant, location) only and wrote the same figure to every
          // lot row at that location.
          for (const line of data.lines) {
            const soLine = so.lines.find((l) => l.id === line.soLineId);
            if (!soLine) continue;
            await deps.projection.syncOutgoing(tx, orgId, {
              productVariantId: soLine.productVariantId,
              locationId: line.locationId,
              lotId: line.lotId ?? null,
              serialId: line.serialId ?? null,
            });
          }

          await tx.update(invSalesOrders)
            .set({ status: allPicked ? "PICKED" : so.status, updatedAt: new Date() })
            .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

          return { pickListId: pickList!.id, pickNumber, allPicked };
        },
        (stored) => revivePickResult(stored),
      ),
    );

    await deps.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await deps.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));

    return result;
  }

  /**
   * A3. Packing took no key, and it creates documents rather than flipping a
   * status: a retry produced a second package, with a second package number and
   * a second set of lines, against the same picked stock. The package, its lines
   * and the order's status now move together or not at all.
   *
   * B6. Nothing here posts stock, and that is deliberate: the goods left the
   * shelf when the picker took them and leave the building on the internal ship
   * command. A movement raised at the bench would subtract the same units twice.
   */
