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
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { loadOrderableVariants } from "../products/lib/orderable-variants";
import type {
  CreateWaveInput,
  ConfirmPickInput,
  ReportPickExceptionInput,
} from "./dto/picking.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function asRecord(stored: unknown): Record<string, unknown> {
  return typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
}

/** A replayed confirm, rebuilt from the stored JSON. */
function reviveConfirm(stored: unknown): {
  pickLineId: number;
  quantityPicked: string;
  waveComplete: boolean;
  pickedBy: string;
} {
  const row = asRecord(stored);
  return {
    pickLineId: Number(row.pickLineId ?? 0),
    quantityPicked: String(row.quantityPicked ?? "0"),
    waveComplete: row.waveComplete === true,
    pickedBy: String(row.pickedBy ?? ""),
  };
}

/** A replayed exception report, rebuilt from the stored JSON. */
function reviveException(stored: unknown): {
  pickLineId: number;
  reason: string;
  substituteVariantId: number | null;
  substituteQuantity: string | null;
  quantityPicked: string;
  waveComplete: boolean;
  reportedBy: string;
} {
  const row = asRecord(stored);
  return {
    pickLineId: Number(row.pickLineId ?? 0),
    reason: String(row.reason ?? ""),
    substituteVariantId: row.substituteVariantId == null ? null : Number(row.substituteVariantId),
    substituteQuantity: row.substituteQuantity == null ? null : String(row.substituteQuantity),
    quantityPicked: String(row.quantityPicked ?? "0"),
    waveComplete: row.waveComplete === true,
    reportedBy: String(row.reportedBy ?? ""),
  };
}

@Injectable()
export class PickWaveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly numSeq: NumberSequenceService,
    private readonly barcode: InvBarcodeService,
    private readonly projection: StockProjectionService,
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
   * A wave is done when every line is *closed*, and a line closes either by
   * being picked in full or by an exception explaining the rest.
   *
   * Without the second half a short pick leaves the wave open forever and the
   * picker is stuck holding a tote the system will not let them finish -- which
   * is precisely the situation an exception exists to resolve.
   */
  private async waveIsComplete(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    pickListId: number,
  ): Promise<boolean> {
    const lines = await tx
      .select({
        toPick: invPickListLines.quantityToPick,
        picked: invPickListLines.quantityPicked,
        exceptionReason: invPickListLines.exceptionReason,
      })
      .from(invPickListLines)
      .where(
        and(
          eq(invPickListLines.orgId, orgId),
          eq(invPickListLines.pickListId, pickListId),
        ),
      );
    return lines.every(
      (l) =>
        l.exceptionReason !== null ||
        cmpDec(String(l.picked), String(l.toPick)) >= 0,
    );
  }

  /**
   * INV-205 — record why a line could not close as asked.
   *
   * The distinction being preserved is between a line short because the shelf
   * was empty and a line short because the picker moved on. The first is a
   * stock problem and the second is a process problem; a warehouse that cannot
   * tell them apart fixes neither, and the quantity alone cannot tell them
   * apart.
   *
   * A substitution is held to the same catalogue rules as any other demand: the
   * replacement must be a live, sellable variant of this organisation. Swapping
   * in a discontinued SKU at the shelf would route around the gate the
   * catalogue exists to enforce.
   */
  async reportException(
    orgId: string,
    userId: string,
    pickListId: number,
    input: ReportPickExceptionInput,
    idempotencyKey: string,
  ) {
    // A3. A substitution records picked stock against a second variant, so a
    // retry takes the swapped-in units out of availability twice.
    return this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.picking.exception", pickListId, input },
        () => this.reportExceptionInTx(tx, orgId, userId, pickListId, input),
        (stored) => reviveException(stored),
      ),
    );
  }

  private async reportExceptionInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    pickListId: number,
    input: ReportPickExceptionInput,
  ) {
    const [line] = await tx
      .select({
        id: invPickListLines.id,
        productVariantId: invPickListLines.productVariantId,
        locationId: invPickListLines.locationId,
        lotId: invPickListLines.lotId,
        serialId: invPickListLines.serialId,
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

    let substituteVariantId: number | null = null;
    let substituteQuantity: string | null = null;
    // Unchanged by a substitution. `quantityPicked` means how much of *this
    // line's* variant was picked, and folding the substitute into it made
    // packing believe units of the original were in the tote -- it builds its
    // map keyed on productVariantId, so it would accept a package of the
    // original and reject one holding what the picker actually took.
    const quantityPicked = String(line.quantityPicked);

    if (input.reason === "SUBSTITUTED") {
      if (input.substituteVariantId === line.productVariantId) {
        throw new BadRequestException(
          "A substitution has to name a different product",
        );
      }
      // Same gate as a sales order line: a discontinued or archived SKU
      // cannot be introduced at the shelf either.
      await loadOrderableVariants(this.db, orgId, [input.substituteVariantId]);
      substituteVariantId = input.substituteVariantId;
      substituteQuantity = input.quantityPicked;
      // Still bounded by what the line asked for: substituting twelve against
      // a line for five is a different mistake, not a licence.
      const covered = addDec(quantityPicked, input.quantityPicked);
      if (cmpDec(covered, String(line.quantityToPick)) > 0) {
        throw new BadRequestException(
          `Substituting ${input.quantityPicked} would exceed the ${line.quantityToPick} this line asks for`,
        );
      }
    }

    await tx
      .update(invPickListLines)
      .set({
        exceptionReason: input.reason,
        exceptionNotes: input.notes ?? null,
        substituteVariantId,
        substituteQuantity,
        quantityPicked,
      })
      .where(
        and(
          eq(invPickListLines.orgId, orgId),
          eq(invPickListLines.id, input.pickLineId),
        ),
      );

    // The substitute is physically in the tote, so it is picked stock and has
    // to leave availability like any other pick. It is tracked on its own
    // columns rather than folded into `quantityPicked`, so it needed its own
    // call — without it, swapping an item made those units sellable twice.
    if (substituteVariantId !== null && substituteQuantity !== null && line.locationId !== null) {
      await this.projection.syncOutgoing(tx, orgId, {
        productVariantId: substituteVariantId,
        locationId: line.locationId,
        lotId: line.lotId,
        serialId: line.serialId,
      });
    }

    const complete = await this.waveIsComplete(tx, orgId, pickListId);
    await tx
      .update(invPickLists)
      .set({ status: complete ? "COMPLETED" : "IN_PROGRESS" })
      .where(and(eq(invPickLists.orgId, orgId), eq(invPickLists.id, pickListId)));

    return {
      pickLineId: input.pickLineId,
      reason: input.reason,
      substituteVariantId,
      substituteQuantity,
      quantityPicked,
      waveComplete: complete,
      reportedBy: userId,
    };
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
    idempotencyKey: string,
  ) {
    // A3. `quantity_picked` is incremented *relatively* and the availability
    // bucket with it, so a retried confirm picked the same units twice — the
    // one shape where a status guard cannot save you, because there is no
    // status to guard on.
    return this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.picking.confirm", pickListId, input },
        () => this.confirmPickInTx(tx, orgId, userId, pickListId, input),
        (stored) => reviveConfirm(stored),
      ),
    );
  }

  private async confirmPickInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    pickListId: number,
    input: ConfirmPickInput,
  ) {
    const [line] = await tx
      .select({
        id: invPickListLines.id,
        productVariantId: invPickListLines.productVariantId,
        locationId: invPickListLines.locationId,
        lotId: invPickListLines.lotId,
        serialId: invPickListLines.serialId,
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

    // A1/A2. Wave picking wrote `quantity_picked` and nothing else, so units
    // standing in a tote were still counted as available and offered to the
    // next customer — the same defect A1 fixed on the sales-order pick path,
    // left in place on this one. The single-order path already does this.
    //
    // Recomputed from the pick lines rather than incremented: the bucket is
    // derived, and an increment is only ever as correct as its least careful
    // writer.
    const pickedAt = input.locationId ?? line.locationId;
    if (pickedAt !== null) {
      await this.projection.syncOutgoing(tx, orgId, {
        productVariantId: line.productVariantId,
        locationId: pickedAt,
        lotId: line.lotId,
        serialId: line.serialId,
      });
    }

    const complete = await this.waveIsComplete(tx, orgId, pickListId);

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
  }
}
