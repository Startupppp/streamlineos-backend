import { and, asc, eq, inArray } from "drizzle-orm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import type { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import type { SoCoreService } from "../../sales-orders/so-core.service";
import { invSalesOrders, invSoLines } from "../../../../db/schema";
import { allocateWaveLines } from "../pick-allocation";
import { pickConstraintsResolver } from "../pick-allocation-constraints";
import type { CreateWaveInput } from "../dto/picking.schemas";

/**
 * Turning a wave request into the lines it will pick, lifted out of
 * `pick-wave.service.ts` unchanged. Both were private with no caller outside it.
 *
 * `proposeWaveJoin` deliberately STAYED on the service: `waveless.spec.ts` reads
 * that file as a string and asserts the SQL which finds open waves names only
 * real pick-list statuses. Moving it would have made that assertion find nothing
 * and pass on `quoted.length > 0` only by accident.
 */
export interface WavePlanDeps {
  readonly db: Db;
  readonly warehouseScope: WarehouseScopeService;
  readonly settingsService: InventorySettingsService;
  readonly soCore: SoCoreService;
}

  /**
   * The work `createWave` and `joinWave` share: are these orders pickable from
   * this building, what are their lines, and where is each line's stock.
   *
   * Extracted rather than copied. A join that validated orders differently from
   * a create would be a second definition of "ready to pick", and the two would
   * drift the first time one of them was fixed.
   */
export async function planWaveLines(
    deps: WavePlanDeps,orgId: string, userId: string, input: CreateWaveInput) {
    await deps.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);

    const orders = await deps.db.query.invSalesOrders.findMany({
      where: and(
        eq(invSalesOrders.orgId, orgId),
        inArray(invSalesOrders.id, input.soIds),
      ),
      columns: { id: true, status: true, warehouseId: true },
    });

    const missing = input.soIds.filter((id) => !orders.some((o) => o.id === id));
    if (missing.length > 0) {
      throw new NotFoundException(`No such sales order: ${missing.join(", ")}`);
    }

    // Reported together rather than one at a time: a picker told to fix a wave
    // of twelve orders should not discover the problems twelve waves later.
    const notPickable = orders.filter(
      (o) => !["CONFIRMED", "RESERVED", "PARTIALLY_RESERVED"].includes(o.status),
    );
    if (notPickable.length > 0) {
      throw new BadRequestException(
        `These orders are not ready to pick: ${notPickable.map((o) => `${o.id} (${o.status})`).join(", ")}`,
      );
    }
    const wrongWarehouse = orders.filter(
      (o) => o.warehouseId !== null && o.warehouseId !== input.warehouseId,
    );
    if (wrongWarehouse.length > 0) {
      throw new BadRequestException(
        `These orders ship from a different warehouse: ${wrongWarehouse.map((o) => o.id).join(", ")}`,
      );
    }

    const lines = await deps.db
      .select({
        soLineId: invSoLines.id,
        soId: invSoLines.soId,
        productVariantId: invSoLines.productVariantId,
        quantity: invSoLines.quantity,
      })
      .from(invSoLines)
      .where(
        and(eq(invSoLines.orgId, orgId), inArray(invSoLines.soId, input.soIds)),
      )
      .orderBy(asc(invSoLines.productVariantId), asc(invSoLines.id));

    if (lines.length === 0) {
      throw new BadRequestException("Those orders have no lines to pick");
    }

    const settings = await deps.settingsService.get(orgId);
    const constraintsFor = pickConstraintsResolver(deps.db, deps.settingsService, orgId);
    const allocations = await allocateWaveLines(
      deps.db,
      orgId,
      lines.map((l) => ({
        soLineId: l.soLineId,
        soId: l.soId,
        productVariantId: l.productVariantId,
        quantity: String(l.quantity),
      })),
      // D2. Constraints per order, cached per order. A wave spans several
      // customers, and the shelf-life floor is a term of one agreement — see
      // `pick-allocation-constraints.ts`. Without this the whole picking module
      // allocated with no near-expiry tier and no floor, so a wave could promise
      // a lot auto-reserve had refused for the same customer minutes earlier.
      async (productVariantId, quantity, soId) =>
        deps.soCore.findAvailableLotForLine(
          orgId,
          productVariantId,
          input.warehouseId,
          quantity,
          settings.reservationStrategy,
          settings.expiryReservationPolicy,
          await constraintsFor(soId),
        ),
    );

    return { lines, allocations };
  }

  /** The wave line as it is stored, on the grain the allocator resolved. */
export function toWaveLine(
    deps: WavePlanDeps,
    orgId: string,
    pickListId: number,
    line: { soLineId: number; productVariantId: number; quantity: unknown },
    // Typed off the function rather than PickWaveService["planWaveLines"]: that
    // indirection existed only because both were methods on the same class.
    allocations: Awaited<ReturnType<typeof planWaveLines>>["allocations"],
  ) {
    const at = allocations.get(line.soLineId);
    const allocated = at?.status === "ALLOCATED" ? at : null;
    return {
      orgId,
      pickListId,
      soLineId: line.soLineId,
      productVariantId: line.productVariantId,
      locationId: allocated?.locationId ?? null,
      lotId: allocated?.lotId ?? null,
      serialId: allocated?.serialId ?? null,
      // NEO-4. The wave line stands on the same grain the allocation
      // resolved, or the pick empties a different row than the promise
      // holds.
      handlingUnitId: allocated?.handlingUnitId ?? null,
      quantityToPick: String(line.quantity),
      quantityPicked: "0",
    };
  }
