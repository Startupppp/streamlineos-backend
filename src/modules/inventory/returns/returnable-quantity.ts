import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import {
  invCustomerReturnLines,
  invCustomerReturns,
  invGrnLines,
  invGrns,
  invPoLines,
  invShipmentLines,
  invShipments,
} from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { addDec, cmpDec } from "../stock-engine/decimal";

/**
 * B9, item 3 — a return may not send back more than went out, and it may not
 * name a lot or a serial that never went out at all.
 *
 * Both halves are one question asked at three grains. A shipment records what
 * left at the (variant, lot, serial) grain; a return line names whichever grain
 * it knows about. So the comparison is per grain, and a line that names no lot
 * is compared against the variant total — which is also what stops a
 * ten-shipped, six-plus-six-returned pair from passing as two separate lines
 * that are each under the limit.
 *
 * Every quantity here is a `numeric(18,4)` read back as a string and compared
 * with `cmpDec`. `parseFloat` on these is banned: 0.1 + 0.2 is not 0.3, and
 * "did the customer return exactly what we shipped" is precisely the comparison
 * a float gets wrong.
 */

/** The grain a line names, narrowest first. */
type GrainKind = "serial" | "lot" | "variant";

interface Grain {
  kind: GrainKind;
  key: string;
  label: string;
}

export interface ReturnableLine {
  productVariantId: number;
  lotId: number | null;
  serialId: number | null;
  quantity: string;
}

export interface CustomerReturnSource {
  soId: number | null;
  shipmentId: number | null;
}

function grainOf(line: ReturnableLine): Grain {
  if (line.serialId !== null) {
    return {
      kind: "serial",
      key: `s:${line.productVariantId}:${line.serialId}`,
      label: `serial ${line.serialId}`,
    };
  }
  if (line.lotId !== null) {
    return {
      kind: "lot",
      key: `l:${line.productVariantId}:${line.lotId}`,
      label: `lot ${line.lotId}`,
    };
  }
  return {
    kind: "variant",
    key: `v:${line.productVariantId}`,
    label: `variant ${line.productVariantId}`,
  };
}

/**
 * A shipped row contributes to every grain it satisfies: a serialised unit is
 * also one of that lot, and one of that variant. A return line naming no lot
 * has to be able to draw on lot-tracked stock that went out, or every
 * traceable shipment would be unreturnable.
 */
function accrue(
  totals: Map<string, string>,
  row: { productVariantId: number; lotId: number | null; serialId: number | null; quantity: string },
): void {
  const keys = [`v:${row.productVariantId}`];
  if (row.lotId !== null) keys.push(`l:${row.productVariantId}:${row.lotId}`);
  if (row.serialId !== null) keys.push(`s:${row.productVariantId}:${row.serialId}`);
  for (const key of keys) totals.set(key, addDec(totals.get(key) ?? "0", row.quantity));
}

interface GrainRow {
  productVariantId: number;
  lotId: number | null;
  serialId: number | null;
  quantity: string;
}

/**
 * What actually left the building against this order or this shipment.
 *
 * Only `SHIPPED` and `DELIVERED` count. A shipment may be created as a DRAFT
 * with its lines already on it — `ShipmentsService.create` does exactly that —
 * and goods that are packed but still in the building have not been shipped, so
 * nothing can be returned against them.
 */
async function shippedGrains(
  tx: DbOrTx,
  orgId: string,
  source: CustomerReturnSource,
): Promise<GrainRow[]> {
  const sourceMatches = sourceCondition(
    source,
    (shipmentId) => eq(invShipments.id, shipmentId),
    (soId) => eq(invShipments.soId, soId),
  );
  if (!sourceMatches) return [];

  return tx
    .select({
      productVariantId: invShipmentLines.productVariantId,
      lotId: invShipmentLines.lotId,
      serialId: invShipmentLines.serialId,
      quantity: sql<string>`SUM(${invShipmentLines.quantity})::text`,
    })
    .from(invShipmentLines)
    .innerJoin(
      invShipments,
      and(
        eq(invShipments.id, invShipmentLines.shipmentId),
        eq(invShipments.orgId, invShipmentLines.orgId),
      ),
    )
    .where(
      and(
        eq(invShipmentLines.orgId, orgId),
        inArray(invShipments.status, ["SHIPPED", "DELIVERED"]),
        sourceMatches,
      ),
    )
    .groupBy(
      invShipmentLines.productVariantId,
      invShipmentLines.lotId,
      invShipmentLines.serialId,
    );
}

/**
 * What has already come back against the same source, on every return but this
 * one.
 *
 * `CANCELLED` is excluded and nothing else is: a DRAFT return has not moved
 * stock, but it has claimed the units, and letting two drafts each claim the
 * whole shipment only defers the collision to whichever one is approved second.
 */
async function alreadyReturnedGrains(
  tx: DbOrTx,
  orgId: string,
  returnId: number,
  source: CustomerReturnSource,
): Promise<GrainRow[]> {
  const sourceMatches = sourceCondition(
    source,
    (shipmentId) => eq(invCustomerReturns.shipmentId, shipmentId),
    (soId) => eq(invCustomerReturns.soId, soId),
  );
  if (!sourceMatches) return [];

  return tx
    .select({
      productVariantId: invCustomerReturnLines.productVariantId,
      lotId: invCustomerReturnLines.lotId,
      serialId: invCustomerReturnLines.serialId,
      quantity: sql<string>`SUM(${invCustomerReturnLines.quantity})::text`,
    })
    .from(invCustomerReturnLines)
    .innerJoin(
      invCustomerReturns,
      and(
        eq(invCustomerReturns.id, invCustomerReturnLines.returnId),
        eq(invCustomerReturns.orgId, invCustomerReturnLines.orgId),
      ),
    )
    .where(
      and(
        eq(invCustomerReturnLines.orgId, orgId),
        ne(invCustomerReturns.status, "CANCELLED"),
        ne(invCustomerReturns.id, returnId),
        sourceMatches,
      ),
    )
    .groupBy(
      invCustomerReturnLines.productVariantId,
      invCustomerReturnLines.lotId,
      invCustomerReturnLines.serialId,
    );
}

function sourceCondition(
  source: CustomerReturnSource,
  byShipment: (shipmentId: number) => SQL,
  bySalesOrder: (soId: number) => SQL,
): SQL | undefined {
  const parts: SQL[] = [];
  if (source.shipmentId !== null) parts.push(byShipment(source.shipmentId));
  if (source.soId !== null) parts.push(bySalesOrder(source.soId));
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : or(...parts);
}

/**
 * Refuses a customer return that exceeds what shipped, or that names traceable
 * stock which did not.
 *
 * A return that cites neither a sales order nor a shipment is left alone: there
 * is no document to measure it against, and refusing every such return would
 * make a walk-in return impossible. That is the deliberate hole in this rule,
 * and it is narrower than it looks — the frontend creates returns from a
 * shipment or an order.
 */
export async function assertCustomerReturnWithinShipped(
  tx: DbOrTx,
  orgId: string,
  returnId: number,
  source: CustomerReturnSource,
  lines: ReturnableLine[],
): Promise<void> {
  if (source.soId === null && source.shipmentId === null) return;

  const [shippedRows, returnedRows] = await Promise.all([
    shippedGrains(tx, orgId, source),
    alreadyReturnedGrains(tx, orgId, returnId, source),
  ]);

  const shipped = new Map<string, string>();
  for (const row of shippedRows) accrue(shipped, row);

  const claimed = new Map<string, string>();
  for (const row of returnedRows) accrue(claimed, row);
  for (const line of lines) accrue(claimed, line);

  const problems: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const grain = grainOf(line);
    if (seen.has(grain.key)) continue;
    seen.add(grain.key);

    const out = shipped.get(grain.key) ?? "0";
    const back = claimed.get(grain.key) ?? "0";
    if (cmpDec(back, out) <= 0) continue;

    // Nothing at all went out at this grain, which is the lot/serial-match
    // failure rather than an over-return. Said differently because the fix is
    // different: one is "return fewer", the other is "that is not what we sent".
    if (cmpDec(out, "0") === 0 && grain.kind !== "variant") {
      problems.push(`${grain.label} was not shipped on this order`);
      continue;
    }
    problems.push(
      `${grain.label}: ${back} returned against ${out} shipped`,
    );
  }

  if (problems.length > 0) {
    throw new BadRequestException(
      `A return cannot exceed what was shipped — ${problems.join("; ")}`,
    );
  }
}

/**
 * The vendor half of the same rule: an RMA cannot send back more of a receipt
 * than the receipt brought in.
 *
 * Bounded per variant only. A goods receipt records its lot as free text
 * (`inv_grn_lines.lot_number`) and resolves it to an `inv_lots` row at posting
 * time, so there is no receipt-side lot id to match a return line against; a
 * lot check here would compare a number with a string and quietly pass. The
 * serial grain has the same gap. Both are left to the engine, which refuses to
 * take a serial or a lot below zero.
 *
 * A vendor return citing no GRN is unbounded here — the goods being sent back
 * are the org's own stock, and the engine's negative-stock guard is the real
 * floor.
 */
export async function assertVendorReturnWithinReceived(
  tx: DbOrTx,
  orgId: string,
  grnId: number | null,
  lines: ReturnableLine[],
): Promise<void> {
  if (grnId === null) return;

  const receivedRows = await tx
    .select({
      productVariantId: invPoLines.productVariantId,
      quantity: sql<string>`SUM(${invGrnLines.quantityReceived})::text`,
    })
    .from(invGrnLines)
    .innerJoin(
      invGrns,
      and(eq(invGrns.id, invGrnLines.grnId), eq(invGrns.orgId, invGrnLines.orgId)),
    )
    .innerJoin(
      invPoLines,
      and(eq(invPoLines.id, invGrnLines.poLineId), eq(invPoLines.orgId, invGrnLines.orgId)),
    )
    .where(
      and(
        eq(invGrnLines.orgId, orgId),
        eq(invGrnLines.grnId, grnId),
        eq(invGrns.status, "POSTED"),
        // A rejected line never became stock, so it is not available to send
        // back through this door — the receipt already refused it.
        ne(invGrnLines.qualityStatus, "REJECTED"),
      ),
    )
    .groupBy(invPoLines.productVariantId);

  const received = new Map<number, string>();
  for (const row of receivedRows) received.set(row.productVariantId, row.quantity);

  const claimed = new Map<number, string>();
  for (const line of lines) {
    claimed.set(
      line.productVariantId,
      addDec(claimed.get(line.productVariantId) ?? "0", line.quantity),
    );
  }

  const problems: string[] = [];
  for (const [productVariantId, back] of claimed) {
    const inbound = received.get(productVariantId) ?? "0";
    if (cmpDec(back, inbound) > 0) {
      problems.push(
        `variant ${productVariantId}: ${back} returned against ${inbound} received`,
      );
    }
  }

  if (problems.length > 0) {
    throw new BadRequestException(
      `A vendor return cannot exceed what was received — ${problems.join("; ")}`,
    );
  }
}
