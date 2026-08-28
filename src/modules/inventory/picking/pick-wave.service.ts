import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
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
import { addDec, cmpDec } from "../stock-engine/decimal";
import { InvBarcodeService } from "../barcode/inv-barcode.service";
import type { CreateWaveInput, ConfirmPickInput } from "./dto/picking.schemas";

@Injectable()
export class PickWaveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly numSeq: NumberSequenceService,
    private readonly barcode: InvBarcodeService,
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
        lines.map((line) => ({
          orgId,
          pickListId: wave!.id,
          soLineId: line.soLineId,
          productVariantId: line.productVariantId,
          quantityToPick: String(line.quantity),
          quantityPicked: "0",
        })),
      );

      return {
        pickListId: wave!.id,
        pickNumber,
        orderCount: input.soIds.length,
        lineCount: lines.length,
      };
    });
  }

  /**
   * The wave in the order a picker should walk it.
   *
   * Sorted by location code, because a pick list that jumps around the building
   * is the same wasted walk the wave was supposed to remove. Lines with no
   * location yet sort last: they need a decision rather than a walk.
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
      product_variant_id: number;
      sku: string;
      location_id: number | null;
      location_code: string | null;
      quantity_to_pick: string;
      quantity_picked: string;
    }>(sql`
      SELECT pl.id,
             pl.so_line_id,
             pl.product_variant_id,
             v.sku,
             pl.location_id,
             l.code AS location_code,
             pl.quantity_to_pick,
             pl.quantity_picked
      FROM inv_pick_list_lines pl
      JOIN inv_product_variants v
        ON v.org_id = pl.org_id AND v.id = pl.product_variant_id
      LEFT JOIN inv_locations l
        ON l.org_id = pl.org_id AND l.id = pl.location_id
      WHERE pl.org_id = ${orgId} AND pl.pick_list_id = ${pickListId}
      ORDER BY l.code NULLS LAST, pl.id
    `);

    return { ...wave, lines };
  }

  /**
   * Confirm one line, optionally against a scan.
   *
   * The scan check is the reason this is a server concern rather than a UI one.
   * A picker holding the wrong box scans it, the screen says the right SKU
   * because the screen is showing the *task*, and the wrong goods ship. Only
   * the server knows both what was asked for and what was actually read.
   */
  async confirmPick(
    orgId: string,
    userId: string,
    pickListId: number,
    input: ConfirmPickInput,
  ) {
    return this.db.transaction(async (tx) => {
      const [line] = await tx
        .select({
          id: invPickListLines.id,
          productVariantId: invPickListLines.productVariantId,
          quantityToPick: invPickListLines.quantityToPick,
          quantityPicked: invPickListLines.quantityPicked,
        })
        .from(invPickListLines)
        .where(
          and(
            eq(invPickListLines.orgId, orgId),
            eq(invPickListLines.pickListId, pickListId),
            eq(invPickListLines.id, input.pickLineId),
          ),
        );
      if (!line) throw new NotFoundException("Pick line not found");

      if (input.scannedPayload) {
        const scan = await this.barcode.scan(orgId, input.scannedPayload);
        const scannedVariantId =
          scan.variant?.id ??
          (scan.lookup?.type === "variant" ? scan.lookup.variantId : null);
        if (scannedVariantId === null) {
          throw new BadRequestException("That scan does not identify a product");
        }
        if (scannedVariantId !== line.productVariantId) {
          throw new BadRequestException(
            "Scanned item does not match the line being picked",
          );
        }
      }

      const nextPicked = addDec(String(line.quantityPicked), input.quantityPicked);
      if (cmpDec(nextPicked, String(line.quantityToPick)) > 0) {
        throw new BadRequestException(
          `Picking ${input.quantityPicked} would exceed the ${line.quantityToPick} this line asks for`,
        );
      }

      await tx
        .update(invPickListLines)
        .set({ quantityPicked: nextPicked, locationId: input.locationId ?? undefined })
        .where(
          and(
            eq(invPickListLines.orgId, orgId),
            eq(invPickListLines.id, input.pickLineId),
          ),
        );

      const remaining = await tx
        .select({
          toPick: invPickListLines.quantityToPick,
          picked: invPickListLines.quantityPicked,
        })
        .from(invPickListLines)
        .where(
          and(
            eq(invPickListLines.orgId, orgId),
            eq(invPickListLines.pickListId, pickListId),
          ),
        );
      const complete = remaining.every(
        (r) => cmpDec(String(r.picked), String(r.toPick)) >= 0,
      );

      await tx
        .update(invPickLists)
        .set({ status: complete ? "COMPLETED" : "IN_PROGRESS" })
        .where(and(eq(invPickLists.orgId, orgId), eq(invPickLists.id, pickListId)));

      return {
        pickLineId: input.pickLineId,
        quantityPicked: nextPicked,
        waveComplete: complete,
        pickedBy: userId,
      };
    });
  }
}
