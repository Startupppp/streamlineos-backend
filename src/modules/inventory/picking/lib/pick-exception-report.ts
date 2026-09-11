import { and, eq } from "drizzle-orm";
import { invPickListLines } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../../stock-engine/command-events";
import {
  type PickExceptionResult,
  type PickGrain,
  loadPickLine,
  loadWaveContext,
} from "../pick-line";
import { requiresReview } from "../pick-exception-policy";
import {
  type DemandRewrite,
  releaseSoLineReservations,
} from "../pick-substitution";
import type { PickCompletionService } from "../pick-completion.service";
import type { ReportPickExceptionInput } from "../dto/picking.schemas";
import {
  resolveFoundLocation,
  resolveSubstitution,
  type PickSubstitutionDeps,
} from "./pick-exception-branches";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * B5 — the exception report itself: one row written, the reservations behind it
 * put right, and the wave rolled up.
 *
 * Split out of `PickExceptionReportService` for the reason `so-ship.ts` gives:
 * this is a sequence, and the sequence is load-bearing end to end — claim the
 * confirm, resolve the branch, write the line, announce what moved, roll the
 * order up, and only THEN recompute the projection, because the recompute has to
 * read a world where the holds have already moved. The service above it exists
 * to open the transaction and take the idempotency claim, and keeping the two
 * apart is what stops the transaction from being owned in two places.
 *
 * `PickSubstitutionDeps` is extended rather than nested: the branch resolvers in
 * `pick-exception-branches.ts` are reached only from here, and one bag assembled
 * once on the service is less to go wrong than two.
 */
export interface PickExceptionDeps extends PickSubstitutionDeps {
  readonly completion: PickCompletionService;
  readonly audit: InventoryAuditService;
}

export async function reportPickExceptionInTx(
  deps: PickExceptionDeps,
  tx: Tx,
  orgId: string,
  userId: string,
  pickListId: number,
  input: ReportPickExceptionInput,
  idempotencyKey: string,
): Promise<PickExceptionResult> {
  const line = await loadPickLine(tx, orgId, pickListId, input.pickLineId);
  await deps.completion.claimForConfirm(tx, orgId, userId, pickListId);
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
      handlingUnitId: line.handlingUnitId,
    });
  }

  if (input.reason === "SUBSTITUTED") {
    const rewritten = await resolveSubstitution(deps, tx, orgId, userId, line, input);
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
    foundLocationId = await resolveFoundLocation(
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
        // NEO-4. Found somewhere else means the pallet the wave believed in is
        // not where the goods are either, so the unit goes back to unresolved
        // with the lot and serial and is settled by the scan at confirm.
        handlingUnitId: null,
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
      deps.reservations,
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

  await deps.completion.rollUpSoStatus(tx, orgId, line.soLineId);
  const complete = await deps.completion.finishWave(tx, orgId, userId, pickListId);
  // Last, and after every reservation this command touched, for the reason
  // `confirmPick` spells out: the recompute has to read a world where the
  // holds have already moved.
  await deps.completion.syncGrains(tx, orgId, grains);

  await deps.audit.insert(tx, {
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
