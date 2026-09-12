import { and, eq } from "drizzle-orm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { invLocations, invProjectRequirements, invStockReservations } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import type { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import type { ReservationService } from "../../stock-engine/reservation.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { assertPack, coverageFor, requirementOr404 } from "./project-reads";
import {
  assertHoldsInScope,
  heldByLocation,
  resolveReservationLocation,
} from "./reservation-location";
import { addDec, cmpDec } from "../../stock-engine/decimal";
import { PROJECT_REQUIREMENT_SOURCE } from "../inv-projects.constants";
import type { ReserveRequirementInput } from "../dto/inv-projects.schemas";

/**
 * Taking and giving back stock against a project requirement. Lifted out of
 * `inv-projects.service.ts` unchanged.
 *
 * Functions over a `ProjectDeps` bag rather than a second `@Injectable`, the
 * shape `so-ship.ts` established in this module: the DI graph and every caller
 * stay unchanged, and the transaction stays owned by the service that opens it.
 */
export interface ProjectDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: InventoryAuditService;
  readonly settings: InventorySettingsService;
  readonly reservations: ReservationService;
  readonly warehouseScope: WarehouseScopeService;
}

  /**
   * The one gate in this file, and the only thing here that is not org-wide.
   *
   * Asked of the bin the stock **actually stands in**, never of the requirement's
   * `warehouse_id`. That column is an expectation ("which store the site expects
   * to be served from") and `updateRequirementSchema` lets anyone PATCH it, so a
   * gate reading it would answer for a building the hold is not in — and a hold
   * re-homed on paper would gate against the new store while the units stayed at
   * the old one. `inv_stock_reservations.location_id` is where the `committed`
   * quantity was actually written, and it is the only honest question to ask.
   *
   * Both callers ask it before touching anything: `reserveRequirement` because a
   * top-up **replaces** the standing hold, and `releaseRequirement` because
   * releasing hands another building's units back to whoever wants them next.
   * Neither reaches `StockEngineService.executeInTx`, so `assertLocationsInScope`
   * never runs on this path — `releaseReservationInTx` writes
   * `inv_stock_levels.committed` directly and says in its own docblock that the
   * gate belongs at the client-named entry point. This is that entry point.
   *
   * Every hold is asserted before any is touched, so a scoped caller cannot get a
   * partial release. `uniq_inv_reservations_org_source_active` allows one active
   * hold per line, so this loop is one iteration in practice; it is a loop because
   * the release path is one, and a gate that covered only the first row would be
   * a gate that agreed with the code by coincidence.
   *
   * 404, never 403: a "forbidden" on a requirement whose hold sits in another
   * building confirms both the hold and the building exist, which turns a probe
   * into an existence oracle (§4). `assertLocationVisible` already answers that
   * way, and an unattributed hold (`location_id IS NULL`) is attributable to none
   * of the caller's warehouses, so it is refused too — `NULL IN (…)` is NULL, the
   * same rule the rest of the module reads by.
   */
  /**
   * B1 — hold stock for one requirement.
   *
   * The hold itself is `ReservationService`: the engine is the only thing that
   * may increment `committed`, and a second path that touched it would be a
   * second answer to how much is available. This method decides *how much* and
   * *where from*, and hands the rest over.
   *
   * Reserving again on a line that already holds stock **replaces** the hold with
   * a larger one, in one transaction, rather than refusing. One active hold per
   * line is a database constraint, not a product decision, and "Reserve Stock"
   * pressed twice should hold more — not fail with a uniqueness error the
   * operator cannot act on.
   */
export async function reserveRequirement(
    deps: ProjectDeps,
    orgId: string,
    userId: string,
    projectId: number,
    requirementId: number,
    input: ReserveRequirementInput,
  ) {
    await assertPack(deps.settings, orgId);
    const requirement = await requirementOr404(deps.db, orgId, projectId, requirementId);
    if (requirement.status === "CANCELLED") {
      throw new BadRequestException("This requirement is cancelled — reinstate it before reserving stock");
    }

    const [coverage] = await coverageFor(deps.db, orgId, [{ ...requirement, leadTimeDays: null }]);
    const alreadyHeld = coverage?.reservedQty ?? "0";
    const outstanding = coverage?.shortfallQty ?? "0";
    if (cmpDec(outstanding, "0") <= 0) {
      throw new BadRequestException({
        code: "REQUIREMENT_FULLY_COVERED",
        message: "This line is already fully reserved or delivered — there is nothing left to hold.",
      });
    }
    const qty = input.qty ?? outstanding;
    if (cmpDec(qty, outstanding) > 0) {
      throw new BadRequestException({
        code: "RESERVATION_EXCEEDS_REQUIREMENT",
        message: `Only ${outstanding} is still outstanding on this line — reserving ${qty} would hold stock nothing has asked for.`,
      });
    }

    const warehouseId = input.warehouseId ?? requirement.warehouseId ?? undefined;
    if (warehouseId != null) {
      await deps.warehouseScope.assertWarehouseVisible(orgId, userId, warehouseId);
    }

    // The hold that replaces an existing one has to cover both, so the location
    // is resolved against the total rather than against the increment.
    const totalQty = addDec(alreadyHeld, qty);

    const scope = await deps.warehouseScope.resolve(orgId, userId);

    let locationId = input.locationId;
    if (locationId != null) {
      const owned = await deps.db.query.invLocations.findFirst({
        where: and(eq(invLocations.id, locationId), eq(invLocations.orgId, orgId)),
        columns: { id: true },
      });
      if (!owned) throw new NotFoundException("Storage location not found");
      // Owning the bin is tenancy; being shown it is scope. `warehouseId` is
      // optional on this payload, so a caller naming a bare `locationId` skipped
      // the assert above entirely and could take a hold anywhere in the org.
      await deps.warehouseScope.assertLocationVisible(orgId, userId, locationId);
    } else {
      const resolved = await resolveReservationLocation(
        deps.db,
        deps.warehouseScope,
        orgId,
        requirement.productVariantId,
        warehouseId,
        totalQty,
        await heldByLocation(deps.db, orgId, requirementId),
        scope,
      );
      if (resolved.locationId === null) {
        throw new BadRequestException({
          code: "NO_SINGLE_LOCATION_COVERS_QTY",
          message:
            `No single pickable bin${warehouseId != null ? " at this dark store" : ""} holds ${totalQty} available — the largest has ${resolved.best}. ` +
            "Transfer stock in, split the requirement, or reserve from a named bin.",
        });
      }
      locationId = resolved.locationId;
    }

    const existing = await deps.db
      .select({ id: invStockReservations.id, locationId: invStockReservations.locationId })
      .from(invStockReservations)
      .where(
        and(
          eq(invStockReservations.orgId, orgId),
          eq(invStockReservations.sourceType, PROJECT_REQUIREMENT_SOURCE),
          eq(invStockReservations.sourceLineId, String(requirementId)),
          eq(invStockReservations.status, "ACTIVE"),
        ),
      );
    // A top-up releases what is standing before it re-takes the total, so the
    // caller has to be allowed to touch the OLD bin as well as the new one.
    await assertHoldsInScope(deps.warehouseScope, orgId, userId, existing);

    const reservation = await deps.db.transaction(async (tx) => {
      // Replace rather than add: the unique index allows one active hold per
      // line, and releasing inside the same transaction means `committed` is
      // never briefly wrong and never doubly held.
      for (const row of existing) {
        await deps.reservations.releaseReservationInTx(tx, orgId, userId, row.id);
      }
      const created = await deps.reservations.createReservationInTx(tx, orgId, userId, {
        sourceType: PROJECT_REQUIREMENT_SOURCE,
        sourceId: String(projectId),
        sourceLineId: String(requirementId),
        productVariantId: requirement.productVariantId,
        warehouseId,
        locationId,
        qty: totalQty,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
      });
      // The line's own status follows the hold, in the same transaction: a
      // requirement that reads REQUESTED while stock is held for it is a lie the
      // planner acts on.
      const nextStatus = cmpDec(totalQty, addDec(alreadyHeld, outstanding)) >= 0 ? "RESERVED" : "PARTIALLY_FULFILLED";
      await tx
        .update(invProjectRequirements)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(and(eq(invProjectRequirements.id, requirementId), eq(invProjectRequirements.orgId, orgId)));
      await deps.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "project.requirement.reserved",
        resourceType: "inv_project_requirement",
        resourceId: String(requirementId),
        metadata: {
          projectId, addedQty: qty, totalQty, reservationId: created.id,
          warehouseId: warehouseId ?? null, locationId,
          replacedReservationIds: existing.map((r) => r.id),
        },
      });
      return created;
    });

    return reservation;
  }

  /**
   * Releases every active hold on a requirement and puts the line back to REQUESTED.
   *
   * Gated on the bin each hold stands in, which is the half `reserveRequirement`
   * had and this did not. Releasing is not the harmless end of reserving: it
   * hands the units back to whoever asks next, and this path never reaches
   * `StockEngineService.executeInTx`, so nothing downstream was going to catch
   * it. A picker assigned to one building could take any project requirement id
   * in the organisation and drop another building's hold — and because the
   * project surface is org-wide by design (see the class docblock), every id they
   * needed was already on the screen in front of them.
   */
export async function releaseRequirement(
    deps: ProjectDeps,orgId: string, userId: string, projectId: number, requirementId: number) {
    await assertPack(deps.settings, orgId);
    await requirementOr404(deps.db, orgId, projectId, requirementId);

    const active = await deps.db
      .select({ id: invStockReservations.id, locationId: invStockReservations.locationId })
      .from(invStockReservations)
      .where(
        and(
          eq(invStockReservations.orgId, orgId),
          eq(invStockReservations.sourceType, PROJECT_REQUIREMENT_SOURCE),
          eq(invStockReservations.sourceLineId, String(requirementId)),
          eq(invStockReservations.status, "ACTIVE"),
        ),
      );
    if (active.length === 0) {
      throw new BadRequestException({
        code: "NO_ACTIVE_RESERVATION",
        message: "Nothing is currently held for this line.",
      });
    }
    // The 400 above and the 404 below do tell an out-of-scope caller whether a
    // hold exists on this line, and that is not a leak here: `getProject`
    // already reports `coverage.reservedQty` on every line to every reader,
    // because the planning surface is org-wide by design. What the gate protects
    // is the ACT, not the fact — the units, and who may hand them back.
    await assertHoldsInScope(deps.warehouseScope, orgId, userId, active);

    const released = await deps.db.transaction(async (tx) => {
      let count = 0;
      for (const row of active) {
        const result = await deps.reservations.releaseReservationInTx(tx, orgId, userId, row.id);
        if (result) count += 1;
      }
      await tx
        .update(invProjectRequirements)
        .set({ status: "REQUESTED", updatedAt: new Date() })
        .where(and(eq(invProjectRequirements.id, requirementId), eq(invProjectRequirements.orgId, orgId)));
      await deps.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "project.requirement.released",
        resourceType: "inv_project_requirement",
        resourceId: String(requirementId),
        metadata: { projectId, releasedCount: count },
      });
      return count;
    });

    return { released };
  }
