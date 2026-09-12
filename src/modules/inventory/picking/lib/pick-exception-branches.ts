import { BadRequestException, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import type { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import type { ReservationService } from "../../stock-engine/reservation.service";
import type { SoCoreService } from "../../sales-orders/so-core.service";
import { addDec, cmpDec } from "../../stock-engine/decimal";
import { resolvePickConstraints } from "../pick-allocation-constraints";
import type { PickLineRow } from "../pick-line";
import {
  type DemandRewrite,
  assertSubstitutable,
  assertSubstitutionCoversLine,
  loadSoLineDemand,
  pickedAgainstSoLine,
  rewriteSoLineDemand,
} from "../pick-substitution";
import type { ReportPickExceptionInput } from "../dto/picking.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * B5 — the two exception reasons that have to resolve something before the row
 * can be written, and nothing else.
 *
 * `SHORT`, `NOT_FOUND` and `DAMAGED` need no resolution at all: the rest is not
 * coming, the line's reservations are released and the report is the whole of
 * it. `SUBSTITUTED` and `WRONG_LOCATION` are the two that first have to decide
 * WHAT is true — which lot of which product is being promised instead, or which
 * bin the picker was actually standing at — and both of those decisions are
 * gated. That is the seam: these are the gates, the report beside them is the
 * record.
 *
 * Free functions over a deps bag rather than a second `@Injectable`, so the DI
 * graph and every caller of `PickExceptionReportService` are unchanged, and so
 * the substitution keeps running inside the transaction and the idempotency
 * claim its caller already opened.
 */
export interface PickSubstitutionDeps {
  readonly db: Db;
  readonly settings: InventorySettingsService;
  readonly soCore: SoCoreService;
  readonly reservations: ReservationService;
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
export async function resolveSubstitution(
  deps: PickSubstitutionDeps,
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
  await assertSubstitutable(deps.db, orgId, line.productVariantId, input.substituteVariantId);

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
  const settings = await deps.settings.get(orgId);
  // D2. A substitution is still an allocation to this customer, so it takes the
  // same constraints their order took. Without them a picker's substitute could
  // be a lot auto-reserve had refused for breaching that customer's supply
  // agreement — the one path where a rule being skipped is least visible,
  // because the substitution already reads as an exception.
  const constraints = await resolvePickConstraints(
    deps.db,
    deps.settings,
    orgId,
    demand.soId,
  );
  const found = await deps.soCore.findAvailableLotForLine(
    orgId,
    input.substituteVariantId,
    demand.warehouseId,
    input.quantityPicked,
    settings.reservationStrategy,
    settings.expiryReservationPolicy,
    constraints,
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
    deps.reservations,
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
export async function resolveFoundLocation(
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
