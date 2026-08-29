import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  invPickLists,
  invPickListLines,
  invSalesOrders,
  invSoLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { SoCoreService } from "../sales-orders/so-core.service";
import { allocateWaveLines } from "./pick-allocation";
import { assertClaimHeldBy } from "./pick-line";
import { PICK_LINE_CLOSED_SQL } from "./pick-exception-policy";
import { queryWaveQueue } from "./pick-wave-queue";
import type { CreateWaveInput, ListWavesInput, ReassignWaveInput } from "./dto/picking.schemas";

@Injectable()
export class PickWaveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly numSeq: NumberSequenceService,
    private readonly settingsService: InventorySettingsService,
    private readonly soCore: SoCoreService,
    private readonly audit: InventoryAuditService,
  ) {}

  /**
   * INV-204 — a wave is one walk across several orders.
   *
   * The existing pick path records what was picked after the fact, one order at
   * a time. That is the wrong shape for a warehouse: a picker walking the same
   * aisle four times because four orders each wanted one item from it is the
   * cost this ticket exists to remove.
   *
   * The header carries no `soId` -- that column stays null for a wave, which is
   * what distinguishes it from a single-order pick -- and each line keeps its
   * own `soLineId` so the goods can be split back to their orders at packing.
   * Nothing about which order a unit belongs to is lost by picking them
   * together.
   *
   * B4, item 1. Every line is now allocated to a location and lot before the
   * picker sees it, through `allocateWaveLines`. A line with no location is a
   * task with no instruction, and it also has no projection grain to write to,
   * so a confirm against one silently left the picked units sellable.
   */
  async createWave(orgId: string, userId: string, input: CreateWaveInput) {
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);

    const orders = await this.db.query.invSalesOrders.findMany({
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

    const lines = await this.db
      .select({
        soLineId: invSoLines.id,
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

    const settings = await this.settingsService.get(orgId);
    const allocations = await allocateWaveLines(
      this.db,
      orgId,
      lines.map((l) => ({
        soLineId: l.soLineId,
        productVariantId: l.productVariantId,
        quantity: String(l.quantity),
      })),
      (productVariantId, quantity) =>
        this.soCore.findAvailableLotForLine(
          orgId,
          productVariantId,
          input.warehouseId,
          quantity,
          settings.reservationStrategy,
          settings.expiryReservationPolicy,
        ),
    );

    const pickNumber = await this.numSeq.next(orgId, "PICK_LIST");

    return this.db.transaction(async (tx) => {
      const [wave] = await tx
        .insert(invPickLists)
        .values({
          orgId,
          pickNumber,
          // Null: this pick belongs to no single order, which is the whole
          // point of a wave.
          soId: null,
          warehouseId: input.warehouseId,
          status: "PENDING",
          createdBy: userId,
        })
        .returning();

      await tx.insert(invPickListLines).values(
        lines.map((line) => {
          const at = allocations.get(line.soLineId);
          return {
            orgId,
            pickListId: wave!.id,
            soLineId: line.soLineId,
            productVariantId: line.productVariantId,
            locationId: at?.locationId ?? null,
            lotId: at?.lotId ?? null,
            serialId: at?.serialId ?? null,
            quantityToPick: String(line.quantity),
            quantityPicked: "0",
          };
        }),
      );

      const unallocated = lines.filter(
        (line) => (allocations.get(line.soLineId)?.locationId ?? null) === null,
      ).length;

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "inventory.pick.wave_created",
        resourceType: "inv_pick_lists",
        resourceId: String(wave!.id),
        after: { pickNumber, warehouseId: input.warehouseId, soIds: input.soIds },
        metadata: { lineCount: lines.length, unallocatedLines: unallocated },
      });

      return {
        pickListId: wave!.id,
        pickNumber,
        orderCount: input.soIds.length,
        lineCount: lines.length,
        // Surfaced rather than swallowed: a wave whose lines have nowhere to be
        // picked from is a stock problem the picker cannot solve at the shelf.
        unallocatedLines: unallocated,
      };
    });
  }

  /**
   * B4, item 5 — the workbench's queue.
   *
   * Warehouse-scoped like every other inventory list, and the scope resolution
   * lives here rather than in the query file so the query stays a query.
   */
  async listWaves(orgId: string, userId: string, filters: ListWavesInput) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    return queryWaveQueue(this.db, orgId, userId, filters, (column) =>
      this.warehouseScope.warehousePredicate(scope, column),
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
   */
  async getWave(orgId: string, userId: string, pickListId: number) {
    const wave = await this.db.query.invPickLists.findFirst({
      where: and(eq(invPickLists.id, pickListId), eq(invPickLists.orgId, orgId)),
    });
    if (!wave) throw new NotFoundException("Pick list not found");
    if (wave.warehouseId !== null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, wave.warehouseId);
    }

    const lines = await this.db.execute<{
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
             ${PICK_LINE_CLOSED_SQL} AS line_closed
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

  /**
   * B4, item 3 — claim, abandon, reassign.
   *
   * All three are conditional single statements, and that is what makes them
   * safe to retry and impossible to double-count. Claiming fires only while the
   * wave is unclaimed, so the loser of a race is told it is taken rather than
   * quietly sharing it; abandoning fires only on the holder's own claim;
   * reassigning refuses a wave that is already finished. None of them touches a
   * quantity, so no repetition of any of them can move stock.
   */
  async claimWave(orgId: string, userId: string, pickListId: number) {
    const wave = await this.assertWaveVisible(orgId, userId, pickListId);
    if (wave.status === "COMPLETED" || wave.status === "CANCELLED") {
      throw new BadRequestException("This wave is already finished");
    }

    const claimed = await this.db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: number }>(sql`
        UPDATE inv_pick_lists
           SET assigned_to = ${userId}, claimed_at = NOW(), updated_at = NOW()
         WHERE org_id = ${orgId} AND id = ${pickListId} AND assigned_to IS NULL
        RETURNING id
      `);
      if (rows.length > 0) {
        await this.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "inventory.pick.wave_claimed",
          resourceType: "inv_pick_lists",
          resourceId: String(pickListId),
          after: { assignedTo: userId },
        });
      }
      return rows.length > 0;
    });

    // A claim the caller already holds is not a failure: retrying a claim is
    // exactly what a flaky warehouse network produces.
    if (!claimed) assertClaimHeldBy(wave.assignedTo, userId);

    return { pickListId, assignedTo: userId, claimed };
  }

  async abandonWave(orgId: string, userId: string, pickListId: number) {
    const wave = await this.assertWaveVisible(orgId, userId, pickListId);
    assertClaimHeldBy(wave.assignedTo, userId);

    const released = await this.db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: number }>(sql`
        UPDATE inv_pick_lists
           SET assigned_to = NULL, claimed_at = NULL, updated_at = NOW()
         WHERE org_id = ${orgId} AND id = ${pickListId} AND assigned_to = ${userId}
        RETURNING id
      `);
      if (rows.length > 0) {
        await this.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "inventory.pick.wave_abandoned",
          resourceType: "inv_pick_lists",
          resourceId: String(pickListId),
          before: { assignedTo: userId },
          after: { assignedTo: null },
        });
      }
      return rows.length > 0;
    });

    // What was already picked stays picked. Abandoning gives up the walk, not
    // the goods already in the tote — unwinding those is what an exception is
    // for, and inventing a second unwind here would be a silent stock movement.
    return { pickListId, assignedTo: null, released };
  }

  async reassignWave(
    orgId: string,
    userId: string,
    pickListId: number,
    input: ReassignWaveInput,
  ) {
    const wave = await this.assertWaveVisible(orgId, userId, pickListId);
    if (wave.status === "COMPLETED" || wave.status === "CANCELLED") {
      throw new BadRequestException("This wave is already finished");
    }

    const [member] = await this.db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM organization_members
       WHERE org_id = ${orgId} AND user_id = ${input.assigneeUserId}
         AND status = 'ACTIVE'
    `);
    // 404 rather than 403: a caller learning that a given user id does exist in
    // some other organisation is an existence oracle.
    if (!member) throw new NotFoundException("That person is not a member of this organisation");

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE inv_pick_lists
           SET assigned_to = ${input.assigneeUserId}, claimed_at = NOW(), updated_at = NOW()
         WHERE org_id = ${orgId} AND id = ${pickListId}
      `);
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "inventory.pick.wave_reassigned",
        resourceType: "inv_pick_lists",
        resourceId: String(pickListId),
        before: { assignedTo: wave.assignedTo },
        after: { assignedTo: input.assigneeUserId },
      });
      return { pickListId, assignedTo: input.assigneeUserId };
    });
  }

  private async assertWaveVisible(orgId: string, userId: string, pickListId: number) {
    const wave = await this.db.query.invPickLists.findFirst({
      where: and(eq(invPickLists.id, pickListId), eq(invPickLists.orgId, orgId)),
      columns: { id: true, status: true, warehouseId: true, assignedTo: true },
    });
    if (!wave) throw new NotFoundException("Pick list not found");
    if (wave.warehouseId !== null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, wave.warehouseId);
    }
    return wave;
  }
}
