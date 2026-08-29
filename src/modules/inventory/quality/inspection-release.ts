import { BadRequestException, ConflictException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { invStockLevels, invVendorReturns, invVendorReturnLines } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { isPositive } from "../stock-engine/decimal";
import type { StockMovement } from "../stock-engine/stock-engine.types";
import type { DisposeInspectionInput } from "./dto/quality.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The subset of an inspection line the stock side of a verdict needs. */
export interface ReleasableLine {
  id: number;
  productVariantId: number;
  locationId: number | null;
  lotId: number | null;
  serialId: number | null;
  quantity: string;
  heldQuantity: string;
}

export interface LocatedLine extends ReleasableLine {
  resolvedLocationId: number;
}

/**
 * D3 — where a line's units are standing, and the order the movements must go in.
 *
 * A bucket movement has to be posted at the location it was raised at. The old
 * lookup keyed stock levels on `(variant, lot, serial)` and dropped the
 * location, so one SKU in two bins collapsed to whichever row the query returned
 * first and the release landed in the wrong aisle. A receipt-raised line carries
 * its own `location_id`; a line created by hand before this existed falls back to
 * the level lookup, which is the old behaviour and no worse than it was.
 */
export async function locateLines(
  tx: Tx,
  orgId: string,
  lines: readonly ReleasableLine[],
  overrides: ReadonlyMap<number, number>,
): Promise<LocatedLine[]> {
  const needsLookup = lines.filter(
    (line) => overrides.get(line.id) === undefined && line.locationId === null,
  );
  const fallback = new Map<string, number>();
  if (needsLookup.length > 0) {
    const rows = await tx
      .select({
        productVariantId: invStockLevels.productVariantId,
        locationId: invStockLevels.locationId,
        lotId: invStockLevels.lotId,
        serialId: invStockLevels.serialId,
      })
      .from(invStockLevels)
      .where(
        and(
          eq(invStockLevels.orgId, orgId),
          inArray(
            invStockLevels.productVariantId,
            [...new Set(needsLookup.map((line) => line.productVariantId))],
          ),
        ),
      );
    for (const row of rows) {
      const key = grainKey(row.productVariantId, row.lotId, row.serialId);
      if (!fallback.has(key)) fallback.set(key, row.locationId);
    }
  }

  return lines.map((line) => {
    const resolved =
      overrides.get(line.id) ??
      line.locationId ??
      fallback.get(grainKey(line.productVariantId, line.lotId, line.serialId));
    if (resolved === undefined)
      throw new BadRequestException(`No stock location found for inspection line ${line.id}`);
    return { ...line, resolvedLocationId: resolved };
  });
}

/**
 * Clears whatever this inspection is holding on the given lines.
 *
 * The figure released is `held_quantity` — what this document raised — not the
 * line quantity and not "whatever the level happens to show". Releasing a line
 * quantity against a level held by somebody else's document is how a hold
 * becomes unreleasable, and reading the level to decide is a race as well as a
 * guess.
 */
export function releaseMovements(lines: readonly LocatedLine[]): StockMovement[] {
  return lines
    .filter((line) => isPositive(line.heldQuantity))
    .map((line) => ({
      transactionType: "QUARANTINE_OUT",
      productVariantId: line.productVariantId,
      locationId: line.resolvedLocationId,
      lotId: line.lotId ?? undefined,
      serialId: line.serialId ?? undefined,
      quantityDelta: `-${line.heldQuantity}`,
      qualityBucket: "QUALITY_HOLD",
    }));
}

/**
 * D3 — the stock side of a disposition, as one ordered list.
 *
 * Order is the whole subtlety, and splitting it into three commands is what made
 * it wrong. `blocked_qty` and `quality_hold_qty` are both subsets of `on_hand`,
 * so quarantining held goods without first clearing the hold makes
 * `blocked + hold > on_hand` and the engine refuses the disposition outright;
 * scrapping them without clearing it drives `on_hand` below a hold that is still
 * standing, which the same guard refuses. Every release therefore comes first, in
 * the same command, where the engine carries each grain's state forward between
 * movements.
 *
 * RETURN_TO_VENDOR appears only in the release half. The quality decision has
 * been made and the goods now leave on a vendor return, whose posting issues them
 * from `on_hand` and would be refused by the same guard if a hold were still on
 * them.
 */
export function dispositionMovements(
  located: readonly LocatedLine[],
  input: DisposeInspectionInput,
): StockMovement[] {
  const byLineId = new Map(located.map((line) => [line.id, line]));
  const movements: StockMovement[] = releaseMovements(located);
  for (const dl of input.lines) {
    const line = byLineId.get(dl.lineId);
    if (!line) throw new BadRequestException(`Line ${dl.lineId} not found`);
    const base = {
      productVariantId: line.productVariantId,
      locationId: line.resolvedLocationId,
      lotId: line.lotId ?? undefined,
      serialId: line.serialId ?? undefined,
    };
    if (dl.disposition === "QUARANTINE") {
      movements.push({
        transactionType: "QUARANTINE_IN",
        ...base,
        quantityDelta: line.quantity,
        qualityBucket: "BLOCKED",
      });
    } else if (dl.disposition === "SCRAP") {
      movements.push({ transactionType: "SCRAP", ...base, quantityDelta: `-${line.quantity}` });
    }
  }
  return movements;
}

/**
 * One draft vendor return per vendor named in the disposition, on the caller's
 * transaction. A rejection that produces no paperwork is a rejection nobody
 * chases.
 */
export async function raiseVendorReturns(
  tx: Tx,
  orgId: string,
  userId: string,
  input: DisposeInspectionInput,
  located: readonly LocatedLine[],
  nextReturnNumber: (tx: Tx) => Promise<string>,
): Promise<void> {
  const byLineId = new Map(located.map((line) => [line.id, line]));
  const byVendor = new Map<number, LocatedLine[]>();
  for (const dl of input.lines) {
    if (dl.disposition !== "RETURN_TO_VENDOR") continue;
    if (dl.vendorId === undefined)
      throw new BadRequestException("vendorId required for RETURN_TO_VENDOR");
    const line = byLineId.get(dl.lineId);
    if (!line) throw new BadRequestException(`Line ${dl.lineId} not found`);
    const bucket = byVendor.get(dl.vendorId) ?? [];
    bucket.push(line);
    byVendor.set(dl.vendorId, bucket);
  }

  for (const [vendorId, lines] of byVendor) {
    const returnNumber = await nextReturnNumber(tx);
    const [ret] = await tx
      .insert(invVendorReturns)
      .values({ orgId, returnNumber, vendorId, status: "DRAFT", createdBy: userId })
      .returning({ id: invVendorReturns.id });
    if (!ret) throw new ConflictException("Could not raise the vendor return");
    await tx.insert(invVendorReturnLines).values(
      lines.map((line) => ({
        orgId,
        returnId: ret.id,
        productVariantId: line.productVariantId,
        lotId: line.lotId,
        serialId: line.serialId,
        quantity: line.quantity,
        reason: "QUALITY_REJECTED" as const,
      })),
    );
  }
}

function grainKey(productVariantId: number, lotId: number | null, serialId: number | null): string {
  return `${productVariantId}:${lotId ?? "null"}:${serialId ?? "null"}`;
}
