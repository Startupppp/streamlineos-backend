import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invPickListLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { addDec, cmpDec } from "../stock-engine/decimal";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
import { SoCoreService } from "../sales-orders/so-core.service";
import type { ReportPickExceptionInput } from "./dto/picking.schemas";
import {
  type PickExceptionResult,
  type PickGrain,
  type PickLineRow,
  loadPickLine,
  loadWaveContext,
  reviveException,
} from "./pick-line";
import { requiresReview } from "./pick-exception-policy";
import {
  type DemandRewrite,
  assertSubstitutable,
  assertSubstitutionCoversLine,
  loadSoLineDemand,
  pickedAgainstSoLine,
  releaseSoLineReservations,
  rewriteSoLineDemand,
} from "./pick-substitution";
import { PickCompletionService } from "./pick-completion.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * B5 — why a line could not close as asked, and what that does to the promise
 * behind it.
 *
 * Split from `PickConfirmService` because it is the other half of the shelf: one
 * records what a picker found, the other records what they did not, and only the
 * second has to unwind a reservation, rewrite a sales-order line or send the row
 * to a supervisor. They share `PickCompletionService`, which is where the
 * sequence they both depend on lives, and nothing else.
 *
 * `PickExceptionService` is the third piece and deliberately not this one: it
 * owns what happens to an exception *after* the picker has walked away, which is
 * a different audience and a different permission.
 */
@Injectable()
export class PickExceptionReportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly completion: PickCompletionService,
    private readonly audit: InventoryAuditService,
    private readonly reservations: ReservationService,
    private readonly settings: InventorySettingsService,
    private readonly soCore: SoCoreService,
  ) {}

  /**
   * INV-205 / B5 — record why a line could not close as asked, and put the
   * reservation behind it right.
   *
   * The distinction being preserved is between a line short because the shelf
   * was empty and a line short because the picker moved on. The first is a stock
   * problem and the second is a process problem; a warehouse that cannot tell
   * them apart fixes neither, and the quantity alone cannot tell them apart.
   *
   * **The defect B5 closes.** Reporting an exception used to write the reason and
   * stop, leaving the reservation still holding the units nobody was going to
   * pick. `committed` stayed at the whole ordered quantity, `EXPECTED_OUTGOING`
   * subtracts the entire remaining `committed` and so clamped to zero, and a
   * five-unit line short-picked at two withdrew five units from availability for
   * good — three of them sitting on the shelf, unsellable, with no document
   * anywhere saying why. So a closing exception now releases the line's
   * reservations, in the same transaction and before the recompute, and the
   * recompute picks the toted units back up through `outgoing_qty`.
   *
   * The reasons behave differently on purpose, and each difference is a fact
   * about the world rather than a policy knob:
   *
   *   * `SHORT` · `NOT_FOUND` · `DAMAGED` — the rest is not coming. Release.
   *   * `WRONG_LOCATION` — the goods exist, the wave sent the picker to the
   *     wrong bin. Retarget the line and keep the reservation: the demand still
   *     stands and the walk is not over.
   *   * `SUBSTITUTED` — something else is in the tote, so the demand itself
   *     changes. See `rewriteSoLineDemand`.
   */
  async reportException(
    orgId: string,
    userId: string,
    pickListId: number,
    input: ReportPickExceptionInput,
    idempotencyKey: string,
  ): Promise<PickExceptionResult> {
    // A3. Claimed as the first statement inside the same transaction as the
    // work, and around every branch rather than only the ones that post
    // something: a substitution records picked stock against a second variant
    // and would take it out of availability twice on a retry, and a release that
    // claimed nothing would let a retry release a reservation somebody had
    // meanwhile re-created.
    return this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.picking.exception", pickListId, input },
        () => this.reportExceptionInTx(tx, orgId, userId, pickListId, input, idempotencyKey),
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
    idempotencyKey: string,
  ): Promise<PickExceptionResult> {
    const line = await loadPickLine(tx, orgId, pickListId, input.pickLineId);
    await this.completion.claimForConfirm(tx, orgId, userId, pickListId);
    const wave = await loadWaveContext(tx, orgId, pickListId);

    let substituteVariantId: number | null = null;
    let substituteQuantity: string | null = null;
    let foundLocationId: number | null = null;
    let locationId = line.locationId;
    let lotId = line.lotId;
    let serialId = line.serialId;
    let rewrite: DemandRewrite | null = null;
    let releasedIds: number[] = [];
    // Unchanged by a substitution. `quantityPicked` means how much of *this
    // line's* variant was picked, and folding the substitute into it made
    // packing believe units of the original were in the tote -- it builds its
    // map keyed on productVariantId, so it would accept a package of the
    // original and reject one holding what the picker actually took.
    const quantityPicked = String(line.quantityPicked);

    const grains: PickGrain[] = [];
    // The grain the line stands on today, recomputed whatever happens: every
    // branch below either releases what was holding it or moves the line off it,
    // and a row left un-recomputed keeps yesterday's `outgoing_qty` for ever.
    if (line.locationId !== null) {
      grains.push({
        productVariantId: line.productVariantId,
        locationId: line.locationId,
        lotId: line.lotId,
        serialId: line.serialId,
      });
    }

    if (input.reason === "SUBSTITUTED") {
      const rewritten = await this.substitute(tx, orgId, userId, line, input);
      rewrite = rewritten.rewrite;
      releasedIds = rewritten.rewrite.releasedReservationIds;
      substituteVariantId = input.substituteVariantId;
      substituteQuantity = input.quantityPicked;
      // Retargeted onto the substitute's grain. `EXPECTED_OUTGOING` credits
      // `substitute_quantity` at the pick line's own (location, lot, serial), so
      // leaving it on the original's bin would put the swapped-in units on a row
      // where that SKU has no stock — and the new reservation, which stands at
      // the substitute's real grain, would be subtracting somewhere else. The
      // two have to meet on one row or availability counts them twice.
      locationId = rewritten.grain.locationId;
      lotId = rewritten.grain.lotId;
      serialId = null;
      grains.push(...rewritten.rewrite.grains);
    } else if (input.reason === "WRONG_LOCATION") {
      foundLocationId = await this.resolveFoundLocation(
        tx,
        orgId,
        wave.warehouseId,
        input.foundLocationId ?? null,
      );
      if (foundLocationId !== null) {
        locationId = foundLocationId;
        // The lot and serial were allocated against the bin the wave believed
        // in. At a different bin they name a stock row that may not exist, so
        // they go back to unresolved and the scan settles them at confirm time,
        // which is the only place the actual unit is ever known.
        lotId = null;
        serialId = null;
        grains.push({
          productVariantId: line.productVariantId,
          locationId: foundLocationId,
          lotId: null,
          serialId: null,
        });
      }
      // Deliberately no reservation change. The units are somewhere in the
      // building and this order still wants them; releasing here would hand
      // stock the picker is standing in front of to the next customer. The
      // reservation's bin is now known to be wrong, and consuming it is what the
      // confirm path already does when the goods come off a different one.
    } else if (line.soLineId !== null) {
      const released = await releaseSoLineReservations(
        tx,
        orgId,
        userId,
        line.soLineId,
        this.reservations,
      );
      releasedIds = released.ids;
      grains.push(...released.grains);
    }

    await tx
      .update(invPickListLines)
      .set({
        exceptionReason: input.reason,
        exceptionNotes: input.notes ?? null,
        // B5, item 2. An exception with nobody's name on it is a note, not a
        // task, and the name is the wave's planner rather than the picker who
        // found it: whether an order ships short is not a decision taken at a
        // shelf. Reassignable afterwards through the review endpoint.
        exceptionOwnerId: wave.createdBy,
        exceptionStatus: "OPEN",
        exceptionResolution: null,
        exceptionResolutionNotes: null,
        exceptionReportedBy: userId,
        exceptionReportedAt: new Date(),
        exceptionResolvedBy: null,
        exceptionResolvedAt: null,
        exceptionLocationId: foundLocationId,
        substituteVariantId,
        substituteQuantity,
        locationId,
        lotId,
        serialId,
        quantityPicked,
      })
      .where(
        and(
          eq(invPickListLines.orgId, orgId),
          eq(invPickListLines.id, input.pickLineId),
        ),
      );

    if (releasedIds.length > 0) {
      // A5. One event for the command, keyed on the command's own idempotency
      // key, rather than one per reservation — the set is the fact, and a
      // replayed command never reaches here to emit a second one.
      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.RESERVATION_RELEASED,
        aggregateType: "inv_stock_reservation",
        aggregateId: idempotencyKey,
        actorUserId: userId,
        payload: {
          reservationIds: releasedIds,
          sourceType: "inv_sales_order",
          sourceLineId: line.soLineId === null ? null : String(line.soLineId),
          releasedBy: "picking.exception",
          reason: input.reason,
        },
      });
    }

    if (rewrite?.newReservationId != null) {
      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.RESERVATION_CREATED,
        aggregateType: "inv_stock_reservation",
        aggregateId: String(rewrite.newReservationId),
        actorUserId: userId,
        payload: {
          reservationId: rewrite.newReservationId,
          sourceType: "inv_sales_order",
          sourceLineId: line.soLineId === null ? null : String(line.soLineId),
          productVariantId: substituteVariantId,
          createdBy: "picking.substitution",
        },
      });
    }

    await this.completion.rollUpSoStatus(tx, orgId, line.soLineId);
    const complete = await this.completion.finishWave(tx, orgId, userId, pickListId);
    // Last, and after every reservation this command touched, for the reason
    // `confirmPick` spells out: the recompute has to read a world where the
    // holds have already moved.
    await this.completion.syncGrains(tx, orgId, grains);

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "inventory.pick.exception",
      resourceType: "inv_pick_list_lines",
      resourceId: String(input.pickLineId),
      before: {
        exceptionReason: line.exceptionReason,
        productVariantId: line.productVariantId,
        locationId: line.locationId,
      },
      after: {
        exceptionReason: input.reason,
        exceptionStatus: "OPEN",
        exceptionOwnerId: wave.createdBy,
        substituteVariantId,
        substituteQuantity,
        locationId,
      },
      metadata: {
        pickListId,
        notes: input.notes ?? null,
        waveComplete: complete,
        soLineId: line.soLineId,
        foundLocationId,
        releasedReservationIds: releasedIds,
        newReservationId: rewrite?.newReservationId ?? null,
        reviewRequired: requiresReview(input.reason),
      },
    });

    return {
      pickLineId: input.pickLineId,
      reason: input.reason,
      status: "OPEN",
      ownerUserId: wave.createdBy,
      substituteVariantId,
      substituteQuantity,
      quantityPicked,
      waveComplete: complete,
      reportedBy: userId,
    };
  }

  /**
   * B5, item 3 — everything a substitution has to be true of before it rewrites
   * anything.
   *
   * Six gates, and each is a way an order has actually gone wrong: the swap must
   * name a different product; the line must belong to an order at all, because
   * there is no demand to rewrite otherwise; that order line must still ask for
   * what the task names, so a second substitution cannot silently overwrite the
   * first; it must stay inside what the task asked for; the substitute must be
   * orderable and measured in the same unit (`assertSubstitutable`); and it must
   * cover the line's whole demand with none of the original already in a tote
   * (`assertSubstitutionCoversLine`).
   */
  private async substitute(
    tx: Tx,
    orgId: string,
    userId: string,
    line: PickLineRow,
    input: Extract<ReportPickExceptionInput, { reason: "SUBSTITUTED" }>,
  ): Promise<{ rewrite: DemandRewrite; grain: { locationId: number; lotId: number | null } }> {
    if (line.soLineId === null) {
      throw new BadRequestException(
        "This task belongs to no order line, so there is no demand to substitute against",
      );
    }
    await assertSubstitutable(this.db, orgId, line.productVariantId, input.substituteVariantId);

    const demand = await loadSoLineDemand(tx, orgId, line.soLineId);
    if (!demand) throw new NotFoundException("The order line behind this task is gone");
    if (demand.productVariantId !== line.productVariantId) {
      throw new BadRequestException(
        "This order line has already been substituted, so it no longer asks for the product this task names",
      );
    }

    // Still bounded by what the line asked for: substituting twelve against a
    // line for five is a different mistake, not a licence.
    const covered = addDec(String(line.quantityPicked), input.quantityPicked);
    if (cmpDec(covered, String(line.quantityToPick)) > 0) {
      throw new BadRequestException(
        `Substituting ${input.quantityPicked} would exceed the ${line.quantityToPick} this line asks for`,
      );
    }

    const alreadyPicked = await pickedAgainstSoLine(tx, orgId, line.soLineId);
    assertSubstitutionCoversLine(input.quantityPicked, alreadyPicked, demand.quantity);

    // The shared FEFO/FIFO allocator, not a private "where is this SKU" query.
    // It has already applied the one availability formula, so the reservation it
    // feeds cannot fail on insufficient stock and roll the whole report back —
    // and a second allocator in this module is how picking once came to promise
    // expired lots.
    const settings = await this.settings.get(orgId);
    const found = await this.soCore.findAvailableLotForLine(
      orgId,
      input.substituteVariantId,
      demand.warehouseId,
      input.quantityPicked,
      settings.reservationStrategy,
      settings.expiryReservationPolicy,
    );
    if (!found) {
      throw new BadRequestException(
        "There is no sellable stock of that product to substitute in, so the order cannot be re-promised against it",
      );
    }

    const grain = { locationId: found.locationId, lotId: found.lotId ?? null };
    const rewrite = await rewriteSoLineDemand(
      tx,
      orgId,
      userId,
      {
        soLineId: line.soLineId,
        fromVariantId: line.productVariantId,
        toVariantId: input.substituteVariantId,
        quantity: input.quantityPicked,
        grain,
        soId: demand.soId,
        warehouseId: demand.warehouseId,
      },
      this.reservations,
    );
    return { rewrite, grain };
  }

  /**
   * Where the picker says the goods actually were, checked before it is written
   * anywhere.
   *
   * Tenant- and warehouse-scoped: a location id from another organisation is a
   * 404 rather than a 403 for the usual reason, and a bin in a different building
   * cannot be where this wave's picker was standing. A wave with no warehouse
   * accepts any of the tenant's locations, which is the only thing it can mean.
   */
  private async resolveFoundLocation(
    tx: Tx,
    orgId: string,
    warehouseId: number | null,
    foundLocationId: number | null,
  ): Promise<number | null> {
    if (foundLocationId === null) return null;
    const [row] = await tx.execute<{ id: number; warehouse_id: number | null }>(sql`
      SELECT id, warehouse_id FROM inv_locations
       WHERE org_id = ${orgId} AND id = ${foundLocationId}
    `);
    if (!row) throw new NotFoundException("No such location in this organisation");
    if (warehouseId !== null && Number(row.warehouse_id) !== warehouseId) {
      throw new BadRequestException("That location is in a different warehouse from this wave");
    }
    return Number(row.id);
  }
}
