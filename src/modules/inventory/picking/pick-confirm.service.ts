import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invPickListLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InvBarcodeService } from "../barcode/inv-barcode.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { SoCoreService } from "../sales-orders/so-core.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { addDec, cmpDec } from "../stock-engine/decimal";
import { INV_ERRORS } from "../stock-engine/stock-engine.types";
import { LaborService } from "../labor/labor.service";
import { NoopWesAdapter, notifyWes } from "../wes/wes-adapter";
import { allocateFromAvailableStock } from "./pick-allocation";
import type { ConfirmPickInput } from "./dto/picking.schemas";
import {
  type PickGrain,
  type PickLineRow,
  loadPickLine,
  loadWaveContext,
  reviveConfirm,
} from "./pick-line";
import { resolvePickConstraints } from "./pick-allocation-constraints";
import { soIdForLine } from "./pick-so-lookup";
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
  private readonly logger = new Logger(PickConfirmService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly barcode: InvBarcodeService,
    private readonly completion: PickCompletionService,
    private readonly audit: InventoryAuditService,
    private readonly settings: InventorySettingsService,
    private readonly soCore: SoCoreService,
    private readonly labor: LaborService,
    private readonly wes: NoopWesAdapter,
  ) {}

  /**
   * Confirm one line, optionally against a scan.
   *
   * The scan check is the reason this is a server concern rather than a UI one.
   * A picker holding the wrong box scans it, the screen says the right SKU
   * because the screen is showing the *task*, and the wrong goods ship. Only the
   * server knows both what was asked for and what was actually read.
   *
   * R3, item 1. A confirm now always ends up at a real bin, or it is refused:
   * see `resolvePickTarget`. The null case used to be silent, and silence was
   * the whole defect — the quantity landed and the projection did not.
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

    const target = await this.resolvePickTarget(tx, orgId, pickListId, line, input);
    const pickedAt = target.locationId;
    const pickedLot = scanned.lotId ?? target.lotId;

    await tx
      .update(invPickListLines)
      .set({
        quantityPicked: nextPicked,
        locationId: pickedAt,
        lotId: pickedLot,
        serialId: scanned.serialId,
        // NEO-4. The unit the picker took the goods off, carried onto the line so
        // the projection can key on it. `target` resolves it the same way it
        // resolves the bin and the lot.
        handlingUnitId: target.handlingUnitId,
      })
      .where(
        and(
          eq(invPickListLines.orgId, orgId),
          eq(invPickListLines.id, input.pickLineId),
        ),
      );

    // R3. Unconditional now: `resolvePickTarget` either produced a bin or threw,
    // so there is no longer a branch in which a confirm writes a quantity and
    // silently skips the projection that makes it stop being sellable.
    const grains: PickGrain[] = [
      {
        productVariantId: line.productVariantId,
        locationId: pickedAt,
        lotId: pickedLot,
        serialId: scanned.serialId,
        handlingUnitId: target.handlingUnitId,
      },
    ];
    // B5. The bin the line *used* to stand on, when the picker took the goods
    // from a different one. `EXPECTED_OUTGOING` is keyed on the pick line's own
    // (location, lot, serial), so moving the line moves which row its picked
    // quantity belongs to — and the row it left keeps whatever was computed
    // there until something recomputes it, which nothing otherwise would.
    if (
      line.locationId !== null &&
      (line.locationId !== pickedAt ||
        line.lotId !== pickedLot ||
        line.serialId !== scanned.serialId ||
        line.handlingUnitId !== target.handlingUnitId)
    ) {
      grains.push({
        productVariantId: line.productVariantId,
        locationId: line.locationId,
        lotId: line.lotId,
        serialId: line.serialId,
        handlingUnitId: line.handlingUnitId,
      });
    }

    // NEO-7. Written from inside the command that finished the work, so a record
    // cannot exist for a confirmation that rolled back and a confirmation cannot
    // happen without one. It is observation, not control: nothing here can refuse
    // the pick, because a picker whose confirmation was rejected by a measurement
    // would rightly stop trusting the device.
    const wave = await loadWaveContext(tx, orgId, pickListId);
    await this.labor.recordInTx(tx, orgId, {
      warehouseId: wave.warehouseId ?? null,
      taskKind: "PICK",
      taskId: pickListId,
      taskLineId: input.pickLineId,
      userId,
      locationId: pickedAt,
      unitsDone: input.quantityPicked,
      scanCount: input.scannedPayload ? 1 : 0,
    });

    // NEO-13. Best-effort, and the helper is what makes that true rather than a
    // convention: an adapter that throws, hangs or refuses leaves the pick
    // exactly as it was. A picker whose confirmation was rejected because a
    // conveyor did not answer would rightly stop trusting the device, and the
    // units have already moved. With no adapter connected this is a debug line.
    await notifyWes(
      this.wes,
      {
        taskRef: `pick:${pickListId}:${input.pickLineId}`,
        kind: "PICK",
        warehouseId: wave.warehouseId ?? 0,
        productVariantId: line.productVariantId,
        fromLocationCode: null,
        toLocationCode: null,
        quantity: input.quantityPicked,
      },
      this.logger,
    );

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
        // R3. Whether the server had to find the bin. A wave that keeps needing
        // this is a wave whose lines were never allocated, and that is a
        // planning fact worth being able to count.
        locationResolvedAtConfirm:
          line.locationId === null && input.locationId === undefined,
      },
    });

    return {
      pickLineId: input.pickLineId,
      quantityPicked: nextPicked,
      pickedAtLocationId: pickedAt,
      waveComplete: complete,
      pickedBy: userId,
    };
  }

  /**
   * R3, item 1 — where these units are actually coming from, settled here or not at all.
   *
   * Three answers, in order:
   *
   *   1. the bin the picker names, which is authoritative — they are standing at
   *      it, and `WRONG_LOCATION` exists for the case where the wave was wrong;
   *   2. the bin the wave allocated, which is the ordinary case;
   *   3. **a fresh allocation through the same shared helper `createWave` uses.**
   *      A line the allocator could not resolve at plan time is often resolvable
   *      by the time somebody picks it — a receipt landed, a hold was released —
   *      and asking again costs one query. It goes through
   *      `findAvailableLotForLine` rather than a local "where is this SKU"
   *      query, so the eligibility, FEFO and expiry terms are the ones a reserve
   *      would have applied.
   *
   * If all three come back empty the confirm is **refused**. It used to succeed:
   * `pickedAt` was null, the row was updated, and the projection grain was
   * skipped, so `quantity_picked` said the goods were in a tote while
   * availability still offered them to the next customer. A 400 naming
   * `LOCATION_NOT_FOUND` is the honest answer — there is nowhere for these units
   * to have come from, and the line needs a decision rather than a confirm.
   */
  private async resolvePickTarget(
    tx: Tx,
    orgId: string,
    pickListId: number,
    line: PickLineRow,
    input: ConfirmPickInput,
  ): Promise<{ locationId: number; lotId: number | null; handlingUnitId: number | null }> {
    // NEO-4. The handling unit comes from the confirm when the picker scanned a
    // pallet label, and otherwise from whatever the line already carried. The
    // auto-allocation branch below resolves a bin and a lot but never a pallet:
    // choosing which of two pallets at a bin to break into is a decision for the
    // person standing in front of them, so it stays null rather than being
    // guessed at, and those units are then picked as loose from that bin.
    const handlingUnitId = input.handlingUnitId ?? line.handlingUnitId;
    const stated = input.locationId ?? line.locationId;
    if (stated !== null) return { locationId: stated, lotId: line.lotId, handlingUnitId };

    const wave = await loadWaveContext(tx, orgId, pickListId);
    const settings = await this.settings.get(orgId);
    // D2. The same constraints auto-reserve honours. Without them a confirm that
    // resolves its own bin could take a lot the reserve path had refused for this
    // customer minutes earlier — the picker would be handed it by the system that
    // had just declined to promise it.
    const constraints = await resolvePickConstraints(
      this.db,
      this.settings,
      orgId,
      line.soLineId === null ? null : await soIdForLine(tx, orgId, line.soLineId),
    );
    const allocation = await allocateFromAvailableStock(
      (productVariantId, quantity) =>
        this.soCore.findAvailableLotForLine(
          orgId,
          productVariantId,
          wave.warehouseId,
          quantity,
          settings.reservationStrategy,
          settings.expiryReservationPolicy,
          constraints,
        ),
      line.productVariantId,
      input.quantityPicked,
    );

    if (allocation.status !== "ALLOCATED") {
      throw new BadRequestException({
        code: INV_ERRORS.LOCATION_NOT_FOUND,
        message:
          "This task has no location and no eligible stock could be found for it. Report an exception or allocate a bin before confirming.",
      });
    }

    return { locationId: allocation.locationId, lotId: line.lotId ?? allocation.lotId, handlingUnitId };
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
