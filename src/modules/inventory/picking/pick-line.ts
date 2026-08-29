import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invPickListLines } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { cmpDec } from "../stock-engine/decimal";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The projection row a pick writes to: variant, place, and which units. */
export interface PickGrain {
  productVariantId: number;
  locationId: number;
  lotId: number | null;
  serialId: number | null;
}

export interface PickLineRow {
  id: number;
  soLineId: number | null;
  productVariantId: number;
  locationId: number | null;
  lotId: number | null;
  serialId: number | null;
  quantityToPick: string;
  quantityPicked: string;
  exceptionReason: string | null;
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
      quantityToPick: invPickListLines.quantityToPick,
      quantityPicked: invPickListLines.quantityPicked,
      exceptionReason: invPickListLines.exceptionReason,
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
 * A wave is done when every line is *closed*, and a line closes either by being
 * picked in full or by an exception explaining the rest.
 *
 * Without the second half a short pick leaves the wave open forever and the
 * picker is stuck holding a tote the system will not let them finish — which is
 * precisely the situation an exception exists to resolve.
 */
export async function waveIsComplete(
  tx: Tx,
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
export function reviveException(stored: unknown): {
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
