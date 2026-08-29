import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invPickListLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InvBarcodeService } from "../barcode/inv-barcode.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { addDec, cmpDec } from "../stock-engine/decimal";
import type { ConfirmPickInput } from "./dto/picking.schemas";
import {
  type PickGrain,
  type PickLineRow,
  loadPickLine,
  reviveConfirm,
} from "./pick-line";
import { PickCompletionService } from "./pick-completion.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * B4, item 2 — what a confirmed pick actually changes.
 *
 * Before this, confirming wrote `quantity_picked` and recomputed
 * `outgoing_qty`, and that was all: the reservation holding those units stayed
 * ACTIVE, the sales order stayed in the status it had before anybody walked
 * anywhere, nothing was audited, and no event said the wave had been picked.
 *
 * **The buckets, and why the order of these statements is load-bearing.**
 *
 * `outgoing_qty` is derived — `EXPECTED_OUTGOING` in
 * `stock-engine/projection-definitions.ts` reads
 * `picked - shipped - EXPECTED_COMMITTED`, clamped at zero. That subtraction is
 * what keeps `committed` and `outgoing_qty` disjoint: while a reservation still
 * covers the picked units they are held once, through `committed`, and the
 * outgoing term is zero.
 *
 * So a pick that consumes its reservation is a *hand-off between two buckets*,
 * and it has exactly one safe order:
 *
 *   1. consume the reservation, which drops `committed` to zero;
 *   2. only then recompute `outgoing_qty`, which now reads `picked - 0` and
 *      picks the units up.
 *
 * The reverse order loses the units entirely — the recompute reads a world
 * where the reservation is still holding them and writes zero, the consume then
 * empties `committed`, and availability jumps by the picked quantity. Stock in a
 * tote would be offered to the next customer. So `completion.syncGrains` is the
 * last call in every command that touches a reservation, in the same transaction
 * as everything it reads, and the sequence lives in `PickCompletionService`
 * rather than in each caller — two copies of it would be two chances to get the
 * order wrong. `PickExceptionReportService` is the other caller: B5 split
 * reporting off this class, because recording what a picker did *not* find has
 * to unwind a promise rather than hand it over, and that is a different job.
 *
 * **Why consuming is the right half of item 2's "engine movement (or
 * reservation consume into picked/outgoing)".**
 *
 * An engine movement at pick time would have to be a bin → staging relocation:
 * a `SALE` here would be posted a second time by `shipSo`, which issues from the
 * pick line's location. A relocation is the honest shape of "goods left the
 * shelf" but it is not this unit's to build — it needs a staging location per
 * warehouse, a column for the bin the goods came *from*, a reverse walk on
 * cancel and short-pick (otherwise cancelled stock is stranded at a
 * non-sellable bin forever), and packing and shipping both read the pick line's
 * location. B6 owns packing, B7 owns "stock posts only on the internal ship
 * command", and half of that change is worse than none. Consuming is the
 * alternative the item names, and it is the one the ledger's own rule allows.
 *
 * It is also a fix rather than a re-labelling. Picking from a bin other than the
 * reserved one used to subtract availability twice — `committed` stranded on the
 * reserved bin, `outgoing_qty` raised on the picked one — and consuming the
 * reservation is what releases the first.
 */
@Injectable()
export class PickConfirmService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly barcode: InvBarcodeService,
    private readonly completion: PickCompletionService,
    private readonly audit: InventoryAuditService,
  ) {}

  /**
   * Confirm one line, optionally against a scan.
   *
   * The scan check is the reason this is a server concern rather than a UI one.
   * A picker holding the wrong box scans it, the screen says the right SKU
   * because the screen is showing the *task*, and the wrong goods ship. Only the
   * server knows both what was asked for and what was actually read.
   */
  async confirmPick(
    orgId: string,
    userId: string,
    pickListId: number,
    input: ConfirmPickInput,
    idempotencyKey: string,
  ) {
    // A3. `quantity_picked` is accumulated *relatively* and the availability
    // buckets move with it, so a retried confirm picked the same units twice —
    // the one shape where a status guard cannot save you, because there is no
    // status to guard on.
    return this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.picking.confirm", pickListId, input },
        () => this.confirmPickInTx(tx, orgId, userId, pickListId, input, idempotencyKey),
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
    idempotencyKey: string,
  ) {
    const line = await loadPickLine(tx, orgId, pickListId, input.pickLineId);
    await this.completion.claimForConfirm(tx, orgId, userId, pickListId);

    const scanned = input.scannedPayload
      ? await this.resolveScan(orgId, line, input.scannedPayload)
      : { lotId: line.lotId, serialId: line.serialId };

    const nextPicked = addDec(String(line.quantityPicked), input.quantityPicked);
    if (cmpDec(nextPicked, String(line.quantityToPick)) > 0) {
      throw new BadRequestException(
        `Picking ${input.quantityPicked} would exceed the ${line.quantityToPick} this line asks for`,
      );
    }

    const pickedAt = input.locationId ?? line.locationId;

    await tx
      .update(invPickListLines)
      .set({
        quantityPicked: nextPicked,
        locationId: pickedAt,
        lotId: scanned.lotId,
        serialId: scanned.serialId,
      })
      .where(
        and(
          eq(invPickListLines.orgId, orgId),
          eq(invPickListLines.id, input.pickLineId),
        ),
      );

    const grains: PickGrain[] = [];
    if (pickedAt !== null) {
      grains.push({
        productVariantId: line.productVariantId,
        locationId: pickedAt,
        lotId: scanned.lotId,
        serialId: scanned.serialId,
      });
    }
    // B5. The bin the line *used* to stand on, when the picker took the goods
    // from a different one. `EXPECTED_OUTGOING` is keyed on the pick line's own
    // (location, lot, serial), so moving the line moves which row its picked
    // quantity belongs to — and the row it left keeps whatever was computed
    // there until something recomputes it, which nothing otherwise would.
    if (
      line.locationId !== null &&
      (line.locationId !== pickedAt ||
        line.lotId !== scanned.lotId ||
        line.serialId !== scanned.serialId)
    ) {
      grains.push({
        productVariantId: line.productVariantId,
        locationId: line.locationId,
        lotId: line.lotId,
        serialId: line.serialId,
      });
    }

    // Step 1 of the hand-off. Before the recompute, always.
    const released = await this.completion.consumeCoveredReservations(
      tx,
      orgId,
      userId,
      line.soLineId,
      idempotencyKey,
    );
    grains.push(...released);

    await this.completion.rollUpSoStatus(tx, orgId, line.soLineId);
    const complete = await this.completion.finishWave(tx, orgId, userId, pickListId);

    // Step 2. Last, and in the same transaction as the reservation consume, the
    // line update and the status flips it reads.
    await this.completion.syncGrains(tx, orgId, grains);

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "inventory.pick.confirmed",
      resourceType: "inv_pick_list_lines",
      resourceId: String(input.pickLineId),
      before: { quantityPicked: String(line.quantityPicked), locationId: line.locationId },
      after: { quantityPicked: nextPicked, locationId: pickedAt },
      metadata: {
        pickListId,
        productVariantId: line.productVariantId,
        scanned: input.scannedPayload !== undefined,
        reservationsConsumed: released.length,
        waveComplete: complete,
      },
    });

    return {
      pickLineId: input.pickLineId,
      quantityPicked: nextPicked,
      waveComplete: complete,
      pickedBy: userId,
    };
  }


  /**
   * B4, item 4 — the scan has to agree with the line on all three axes.
   *
   * Checking only the SKU let a picker scan the right product from the wrong lot
   * and ship a batch the order was never allocated, which for a lot-tracked
   * product is the whole reason lots exist. Where the line carries no lot or
   * serial yet — a wave line for an unreserved order, or a serial-tracked line,
   * which no allocator can resolve — the scan settles it, because the shelf is
   * the only place the actual unit is known.
   */
  private async resolveScan(
    orgId: string,
    line: PickLineRow,
    payload: string,
  ): Promise<{ lotId: number | null; serialId: number | null }> {
    const scan = await this.barcode.scan(orgId, payload);

    const scannedVariantId =
      scan.variant?.id ??
      (scan.lookup?.type === "variant" ? scan.lookup.variantId : null) ??
      (scan.lookup?.type === "lot" ? scan.lookup.variantId : null) ??
      (scan.lookup?.type === "serial" ? scan.lookup.variantId : null);
    if (scannedVariantId === null || scannedVariantId === undefined) {
      throw new BadRequestException("That scan does not identify a product");
    }
    if (scannedVariantId !== line.productVariantId) {
      throw new BadRequestException(
        "Scanned item does not match the line being picked",
      );
    }

    const scannedLotId =
      scan.lot?.id ?? (scan.lookup?.type === "lot" ? scan.lookup.lotId : null);
    if (scannedLotId != null && line.lotId !== null && scannedLotId !== line.lotId) {
      throw new BadRequestException(
        "Scanned lot does not match the lot allocated to this line",
      );
    }

    const scannedSerialId =
      scan.serial?.id ?? (scan.lookup?.type === "serial" ? scan.lookup.serialId : null);
    if (
      scannedSerialId != null &&
      line.serialId !== null &&
      scannedSerialId !== line.serialId
    ) {
      throw new BadRequestException(
        "Scanned serial does not match the serial allocated to this line",
      );
    }

    return {
      lotId: line.lotId ?? scannedLotId ?? null,
      serialId: line.serialId ?? scannedSerialId ?? null,
    };
  }
}
