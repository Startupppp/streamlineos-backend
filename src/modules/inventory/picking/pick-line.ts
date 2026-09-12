import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invPickListLines } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { PICK_LINE_CLOSED_SQL, type PickExceptionReason } from "./pick-exception-policy";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The projection row a pick writes to: variant, place, and which units. */
export interface PickGrain {
  productVariantId: number;
  locationId: number;
  lotId: number | null;
  serialId: number | null;
  /**
   * NEO-4 - the handling unit picked from, or null for loose stock.
   *
   * Part of the grain for the same reason lot and serial are: `EXPECTED_OUTGOING`
   * matches a pick line against a stock-level row on that row's full natural key,
   * and the handling unit is now in it.
   */
  handlingUnitId: number | null;
}

export interface PickLineRow {
  id: number;
  soLineId: number | null;
  productVariantId: number;
  locationId: number | null;
  lotId: number | null;
  serialId: number | null;
  handlingUnitId: number | null;
  quantityToPick: string;
  quantityPicked: string;
  exceptionReason: PickExceptionReason | null;
  exceptionStatus: "OPEN" | "RESOLVED" | null;
  substituteVariantId: number | null;
  substituteQuantity: string | null;
}

/** Loads one line of one wave, tenant- and wave-scoped. */
export async function loadPickLine(
  tx: Tx,
  orgId: string,
  pickListId: number,
  pickLineId: number,
): Promise<PickLineRow> {
  const [line] = await tx
    .select({
      id: invPickListLines.id,
      soLineId: invPickListLines.soLineId,
      productVariantId: invPickListLines.productVariantId,
      locationId: invPickListLines.locationId,
      lotId: invPickListLines.lotId,
      serialId: invPickListLines.serialId,
      handlingUnitId: invPickListLines.handlingUnitId,
      quantityToPick: invPickListLines.quantityToPick,
      quantityPicked: invPickListLines.quantityPicked,
      exceptionReason: invPickListLines.exceptionReason,
      exceptionStatus: invPickListLines.exceptionStatus,
      substituteVariantId: invPickListLines.substituteVariantId,
      substituteQuantity: invPickListLines.substituteQuantity,
    })
    .from(invPickListLines)
    .where(
      and(
        eq(invPickListLines.orgId, orgId),
        eq(invPickListLines.pickListId, pickListId),
        eq(invPickListLines.id, pickLineId),
      ),
    );
  if (!line) throw new NotFoundException("Pick line not found");
  return line;
}

/**
 * A wave is done when every line is *closed*, and what closes a line is
 * `PICK_LINE_CLOSED_SQL` — the one expression the wave board's progress column
 * and the supervisor queue's blocking count also read.
 *
 * Without the exception half a short pick leaves the wave open forever and the
 * picker is stuck holding a tote the system will not let them finish, which is
 * precisely the situation an exception exists to resolve. B5 adds the other two
 * halves: a `WRONG_LOCATION` report does not close anything, because the goods
 * are somewhere and the walk is not over; and a damaged or substituted line
 * closes only once a reviewer has signed it, which is what "unresolved can block
 * wave complete where required" means in practice.
 *
 * One statement rather than a fetch-and-fold, so the quantity comparison stays
 * in `numeric`.
 */
export async function waveIsComplete(
  tx: Tx,
  orgId: string,
  pickListId: number,
): Promise<boolean> {
  const [row] = await tx.execute<{ complete: boolean }>(sql`
    SELECT NOT EXISTS (
      SELECT 1
        FROM inv_pick_list_lines pll
       WHERE pll.org_id = ${orgId}
         AND pll.pick_list_id = ${pickListId}
         AND NOT ${PICK_LINE_CLOSED_SQL}
    ) AS complete
  `);
  return row?.complete === true;
}

/**
 * The claim gate, as a value rather than a query, so both the confirm path and
 * the abandon path refuse in the same words.
 *
 * `ForbiddenException` rather than `NotFoundException`: the caller is inside the
 * right tenant and can already see the wave, so there is no existence to leak —
 * what they lack is the claim.
 */
export function assertClaimHeldBy(assignedTo: string | null, userId: string): void {
  if (assignedTo !== null && assignedTo !== userId) {
    throw new ForbiddenException("Another picker is walking this wave");
  }
}

function asRecord(stored: unknown): Record<string, unknown> {
  return typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
}

/** A replayed confirm, rebuilt from the stored JSON. */
export function reviveConfirm(stored: unknown): {
  pickLineId: number;
  quantityPicked: string;
  /**
   * R3. Where the units were taken from. Non-null on every fresh confirm, since
   * one that could not resolve a bin is now refused; nullable only here, because
   * a response stored before this change carries no such field and inventing a
   * location for it would be worse than admitting the row predates the rule.
   */
  pickedAtLocationId: number | null;
  waveComplete: boolean;
  pickedBy: string;
} {
  const row = asRecord(stored);
  return {
    pickLineId: Number(row.pickLineId ?? 0),
    quantityPicked: String(row.quantityPicked ?? "0"),
    pickedAtLocationId: row.pickedAtLocationId == null ? null : Number(row.pickedAtLocationId),
    waveComplete: row.waveComplete === true,
    pickedBy: String(row.pickedBy ?? ""),
  };
}

/** What reporting an exception answers with, replay or not. */
export interface PickExceptionResult {
  pickLineId: number;
  reason: string;
  status: "OPEN" | "RESOLVED";
  ownerUserId: string | null;
  substituteVariantId: number | null;
  substituteQuantity: string | null;
  quantityPicked: string;
  waveComplete: boolean;
  reportedBy: string;
}

/** A replayed exception report, rebuilt from the stored JSON. */
export function reviveException(stored: unknown): PickExceptionResult {
  const row = asRecord(stored);
  return {
    pickLineId: Number(row.pickLineId ?? 0),
    reason: String(row.reason ?? ""),
    status: row.status === "RESOLVED" ? "RESOLVED" : "OPEN",
    ownerUserId: row.ownerUserId == null ? null : String(row.ownerUserId),
    substituteVariantId: row.substituteVariantId == null ? null : Number(row.substituteVariantId),
    substituteQuantity: row.substituteQuantity == null ? null : String(row.substituteQuantity),
    quantityPicked: String(row.quantityPicked ?? "0"),
    waveComplete: row.waveComplete === true,
    reportedBy: String(row.reportedBy ?? ""),
  };
}

/** The wave header facts an exception needs: who planned it, and where it is. */
export interface PickWaveContext {
  createdBy: string;
  warehouseId: number | null;
}

export async function loadWaveContext(
  tx: Tx,
  orgId: string,
  pickListId: number,
): Promise<PickWaveContext> {
  const [row] = await tx.execute<{ created_by: string; warehouse_id: number | null }>(sql`
    SELECT created_by, warehouse_id FROM inv_pick_lists
     WHERE org_id = ${orgId} AND id = ${pickListId}
  `);
  if (!row) throw new NotFoundException("Pick list not found");
  return {
    createdBy: String(row.created_by),
    warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
  };
}
