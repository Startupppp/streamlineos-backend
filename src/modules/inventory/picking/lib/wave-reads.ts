import { and, eq, sql } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { invPickLists } from "../../../../db/schema";
import { PICK_LINE_CLOSED_SQL } from "../pick-exception-policy";
import { queryWaveQueue } from "../pick-wave-queue";
import type { ListWavesInput } from "../dto/picking.schemas";

/**
 * Listing waves and reading one whole, lifted out of `pick-wave.service.ts`
 * unchanged. Both used the db handle and the warehouse scope and nothing else.
 * Public with controller callers, so the service keeps a delegate for each.
 */
  /**
   * B4, item 5 — the workbench's queue.
   *
   * Warehouse-scoped like every other inventory list, and the scope resolution
   * lives here rather than in the query file so the query stays a query.
   */
export async function listWaves(
    db: Db,
    warehouseScope: WarehouseScopeService,orgId: string, userId: string, filters: ListWavesInput) {
    const scope = await warehouseScope.resolve(orgId, userId);
    return queryWaveQueue(db, orgId, userId, filters, (column) =>
      warehouseScope.warehousePredicate(scope, column),
    );
  }

  /**
   * The wave in the order a picker should walk it.
   *
   * Sorted by location code, because a pick list that jumps around the building
   * is the same wasted walk the wave was supposed to remove. Lines with no
   * location yet sort last: they need a decision rather than a walk.
   *
   * B5. Each line carries `line_closed` from `PICK_LINE_CLOSED_SQL` rather than
   * leaving the workbench to re-derive it from the quantities and the reason.
   * The rule now has three clauses -- picked in full, a closing reason, and a
   * reviewer's signature where one is required -- and a client copy of it would
   * be a fourth place for it to drift, showing a picker a finished row the server
   * still considers outstanding.
   *
   * R3. `needs_decision` is the other half of that: outstanding work with nowhere
   * to walk to. Derived here for the same reason `line_closed` is -- a client
   * inferring it from a null `location_id` would call a line that has already
   * been short-closed a decision somebody still owes.
   */
export async function getWave(
    db: Db,
    warehouseScope: WarehouseScopeService,orgId: string, userId: string, pickListId: number) {
    const wave = await db.query.invPickLists.findFirst({
      where: and(eq(invPickLists.id, pickListId), eq(invPickLists.orgId, orgId)),
    });
    if (!wave) throw new NotFoundException("Pick list not found");
    if (wave.warehouseId !== null) {
      await warehouseScope.assertWarehouseVisible(orgId, userId, wave.warehouseId);
    }

    const lines = await db.execute<{
      id: number;
      so_line_id: number | null;
      so_number: string | null;
      product_variant_id: number;
      sku: string;
      variant_name: string;
      location_id: number | null;
      location_code: string | null;
      lot_id: number | null;
      lot_number: string | null;
      serial_id: number | null;
      serial_number: string | null;
      quantity_to_pick: string;
      quantity_picked: string;
      exception_reason: string | null;
      exception_notes: string | null;
      exception_status: string | null;
      exception_resolution: string | null;
      exception_owner_id: string | null;
      exception_owner_name: string | null;
      exception_location_code: string | null;
      substitute_variant_id: number | null;
      substitute_sku: string | null;
      substitute_quantity: string | null;
      line_closed: boolean;
      needs_decision: boolean;
    }>(sql`
      SELECT pll.id,
             pll.so_line_id,
             so.so_number,
             pll.product_variant_id,
             v.sku,
             v.name AS variant_name,
             pll.location_id,
             l.code AS location_code,
             pll.lot_id,
             lot.lot_number,
             pll.serial_id,
             ser.serial_number,
             pll.quantity_to_pick,
             pll.quantity_picked,
             pll.exception_reason,
             pll.exception_notes,
             pll.exception_status,
             pll.exception_resolution,
             pll.exception_owner_id,
             owner.name AS exception_owner_name,
             found.code AS exception_location_code,
             pll.substitute_variant_id,
             sub.sku AS substitute_sku,
             pll.substitute_quantity,
             ${PICK_LINE_CLOSED_SQL} AS line_closed,
             (pll.location_id IS NULL AND NOT ${PICK_LINE_CLOSED_SQL}) AS needs_decision
      FROM inv_pick_list_lines pll
      JOIN inv_product_variants v
        ON v.org_id = pll.org_id AND v.id = pll.product_variant_id
      LEFT JOIN inv_product_variants sub
        ON sub.org_id = pll.org_id AND sub.id = pll.substitute_variant_id
      LEFT JOIN inv_locations l
        ON l.org_id = pll.org_id AND l.id = pll.location_id
      LEFT JOIN inv_locations found
        ON found.org_id = pll.org_id AND found.id = pll.exception_location_id
      LEFT JOIN inv_lots lot
        ON lot.org_id = pll.org_id AND lot.id = pll.lot_id
      LEFT JOIN inv_serial_numbers ser
        ON ser.org_id = pll.org_id AND ser.id = pll.serial_id
      LEFT JOIN inv_so_lines sol
        ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
      LEFT JOIN inv_sales_orders so
        ON so.org_id = sol.org_id AND so.id = sol.so_id
      -- Explicitly projected: the global users table still holds authentication
      -- secrets and legacy payroll columns, so nothing here reads it through a
      -- relation.
      LEFT JOIN users owner ON owner.id = pll.exception_owner_id
      WHERE pll.org_id = ${orgId} AND pll.pick_list_id = ${pickListId}
      ORDER BY l.code NULLS LAST, pll.id
    `);

    return { ...wave, lines };
  }
