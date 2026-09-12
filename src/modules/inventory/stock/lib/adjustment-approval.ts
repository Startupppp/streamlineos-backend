import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { invLocations, invSettings } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { addDec, cmpDec, mulDec } from "../../stock-engine/decimal";
import type { OrderableVariant } from "../../products/lib/orderable-variants";
import type { CreateAdjustmentInput } from "../dto/inv-stock.schemas";

type AdjustmentLine = CreateAdjustmentInput["lines"][number];

/** The one field of the engine's settings row this policy needs. */
export interface QuantityThreshold {
  adjustmentApprovalThreshold: string | null;
}

const grainKey = (variantId: number, locationId: number) => `${String(variantId)}:${String(locationId)}`;

/**
 * D8 — the two thresholds, and why there are two.
 *
 * The quantity threshold was the only one, and it cannot see the difference
 * between forty screws and forty turbines: a policy of "over 100 units needs a
 * second signature" waves through the destruction of the most valuable pallet
 * in the building. `adjustment_approval_value_threshold` has existed since
 * 0407 and had no reader; it does now, and either threshold alone is enough to
 * route the document to approval.
 *
 * The value is the carrying cost the ledger already holds for those goods (see
 * `carryingValueOf`). It is deliberately NOT the layer walk the posting will
 * do: `planIssue` takes `FOR UPDATE` on the cost layers, and taking those locks
 * here — before the engine takes its stock-level locks — inverts the engine's
 * own lock order and deadlocks against any concurrent sale. The exact figure is
 * recorded after the posting instead, which is the only moment it can be known.
 */
export async function needsApproval(
  db: Db,
  orgId: string,
  settings: QuantityThreshold,
  lines: readonly AdjustmentLine[],
  variants: ReadonlyMap<number, OrderableVariant>,
): Promise<boolean> {
  const totalAbsQty = lines.reduce((sum, l) => addDec(sum, Math.abs(l.quantityChange).toString()), "0");
  if (settings.adjustmentApprovalThreshold !== null && cmpDec(totalAbsQty, settings.adjustmentApprovalThreshold) > 0)
    return true;

  // Read here rather than through `InventorySettingsService`, whose row shape
  // does not carry this column. One narrow projection beats widening a type
  // that eleven other call sites depend on.
  const [policy] = await db
    .select({ valueThreshold: invSettings.adjustmentApprovalValueThreshold })
    .from(invSettings)
    .where(eq(invSettings.orgId, orgId))
    .limit(1);
  const valueThreshold = policy?.valueThreshold ?? null;
  if (valueThreshold === null) return false;

  const bookValue = await carryingValueOf(db, orgId, lines, variants);
  return cmpDec(bookValue, valueThreshold) > 0;
}

/**
 * What the ledger says the goods on these lines are worth, right now.
 *
 * Three sources in falling order of authority, because no single one covers
 * every costing method. `average_cost` on the stock level is what a weighted-
 * average issue will actually be costed at, so it leads — but the engine only
 * maintains it for `WEIGHTED_AVERAGE`, so under FIFO and STANDARD it is null
 * and the open cost layers are the book value instead. The variant's cost
 * price is the last resort, for a grain that has never been costed at all.
 *
 * Every query here is a plain read. Nothing takes `FOR UPDATE`: the posting
 * takes stock-level locks before valuation-layer locks, and a reader that
 * took layer locks first would invert that order and deadlock against any
 * concurrent sale.
 */
async function carryingValueOf(
  db: Db,
  orgId: string,
  lines: readonly AdjustmentLine[],
  variants: ReadonlyMap<number, OrderableVariant>,
): Promise<string> {
  const variantIds = sql.join([...new Set(lines.map((l) => l.productVariantId))].map((id) => sql`${id}`), sql`, `);
  const locationIds = sql.join([...new Set(lines.map((l) => l.locationId))].map((id) => sql`${id}`), sql`, `);

  const [levels, layers] = await Promise.all([
    db.execute<{ variant_id: number; location_id: number; unit_cost: string | null }>(sql`
      SELECT product_variant_id AS variant_id,
             location_id,
             (SUM(on_hand * average_cost) / NULLIF(SUM(on_hand), 0))::text AS unit_cost
      FROM inv_stock_levels
      WHERE org_id = ${orgId}
        AND average_cost IS NOT NULL
        AND product_variant_id IN (${variantIds})
        AND location_id IN (${locationIds})
      GROUP BY 1, 2
    `),
    db.execute<{ variant_id: number; location_id: number; unit_cost: string | null }>(sql`
      SELECT product_variant_id AS variant_id,
             location_id,
             (SUM(remaining_value) / NULLIF(SUM(remaining_quantity), 0))::text AS unit_cost
      FROM inv_valuation_layers
      WHERE org_id = ${orgId}
        AND remaining_quantity > 0
        AND product_variant_id IN (${variantIds})
        AND location_id IN (${locationIds})
      GROUP BY 1, 2
    `),
  ]);

  const carrying = new Map<string, string>();
  for (const source of [layers, levels])
    for (const row of source)
      if (row.unit_cost !== null)
        carrying.set(grainKey(Number(row.variant_id), Number(row.location_id)), row.unit_cost);

  let total = "0";
  for (const line of lines) {
    const unitCost =
      carrying.get(grainKey(line.productVariantId, line.locationId)) ??
      variants.get(line.productVariantId)?.costPrice ??
      "0";
    total = addDec(total, mulDec(unitCost, Math.abs(line.quantityChange).toString()));
  }
  return total;
}

/**
 * D8 — where the condemned goods physically went.
 *
 * Validated rather than stored as given: a bin that is not a scrap bin, is
 * retired, or belongs to a different building than the goods being written
 * off is a record of something that did not happen. Resolved automatically
 * when the caller names none, because an operator writing off a damaged
 * pallet should not have to know the code of their own warehouse's scrap bin.
 * Null is a legitimate answer — a warehouse with no scrap bin still writes
 * stock off, and refusing would make the disposal route a precondition of
 * telling the truth about the shelf.
 */
export async function resolveScrapLocation(
  db: Db,
  orgId: string,
  lines: readonly AdjustmentLine[],
  requested: number | undefined,
): Promise<number | null> {
  const lineLocations = await db
    .select({ id: invLocations.id, warehouseId: invLocations.warehouseId })
    .from(invLocations)
    .where(and(
      eq(invLocations.orgId, orgId),
      inArray(invLocations.id, [...new Set(lines.map((l) => l.locationId))]),
    ));
  const warehouseIds = new Set(lineLocations.map((l) => l.warehouseId));

  if (requested !== undefined) {
    const [bin] = await db
      .select({
        id: invLocations.id,
        warehouseId: invLocations.warehouseId,
        locationType: invLocations.locationType,
        isActive: invLocations.isActive,
      })
      .from(invLocations)
      .where(and(eq(invLocations.orgId, orgId), eq(invLocations.id, requested)))
      .limit(1);
    // Another tenant's location reads as absent, never as forbidden: a 403 on
    // an id confirms the row exists.
    if (!bin) throw new NotFoundException("No such location in this organization");
    if (bin.locationType !== "SCRAP")
      throw new BadRequestException("The scrap location must be a location of type SCRAP");
    if (!bin.isActive)
      throw new BadRequestException("The scrap location is retired and cannot take condemned goods");
    if (!warehouseIds.has(bin.warehouseId)) {
      throw new BadRequestException(
        "The scrap location is in a different warehouse from the goods being written off. Raise one write-off per warehouse.",
      );
    }
    return bin.id;
  }

  // Only when the whole document sits in one building; across two there is no
  // single right answer and guessing one would be worse than recording none.
  if (warehouseIds.size !== 1) return null;
  const [fallback] = await db
    .select({ id: invLocations.id })
    .from(invLocations)
    .where(and(
      eq(invLocations.orgId, orgId),
      eq(invLocations.warehouseId, [...warehouseIds][0]!),
      eq(invLocations.locationType, "SCRAP"),
      eq(invLocations.isActive, true),
    ))
    .orderBy(invLocations.id)
    .limit(1);
  return fallback?.id ?? null;
}