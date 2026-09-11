import { NotFoundException } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  invPlatformPayoutLines,
  invPlatformPoLines,
  invPlatformPurchaseOrders,
} from "../../../../../db/schema";
import { type Db } from "../../../../../db/drizzle.module";
import type { WarehouseScopeService } from "../../../stock-engine/warehouse-scope.service";
import { addDec, cmpDec, divDec, mulDec, subDec } from "../../../stock-engine/decimal";
import type { FillRateQuery } from "../dto/quick-commerce.schemas";

/**
 * NEO-3's read half — the fill-rate report — lifted out of
 * `fill-rate.service.ts` unchanged.
 *
 * The service does two unrelated things to the same three tables. `report`
 * READS: it gates on the platform PO's warehouse, gathers what was received,
 * shipped, returned and paid, and does the arithmetic. `uploadPayout` WRITES:
 * it matches a payout file's rows to PO lines and inserts them, audited, with
 * no warehouse gate at all (a payout file is org-level). They share no private
 * member — none of the four readers below is called by `uploadPayout`, and
 * `uploadPayout`'s matcher is called by nothing here — and they fail
 * differently: this half 404s and 403s, that half refuses an empty file and
 * swallows duplicates on a unique index.
 */
export interface FillRateReportDeps {
  readonly db: Db;
  readonly warehouseScope: WarehouseScopeService;
}

/** One SKU on one platform purchase order, with everything that happened to it. */
export interface FillRateLine {
  platformPoLineId: number;
  productVariantId: number | null;
  providerSku: string | null;
  ean: string | null;
  orderedQty: string;
  /** What arrived at our dock against the purchase order this platform PO raised. */
  receivedQty: string;
  /** What we shipped back out to the platform. */
  shippedQty: string;
  returnedQty: string;
  /** Shipped less returned: the units the platform kept. */
  acceptedQty: string;
  /** `acceptedQty / orderedQty` as a percentage, exact, 4dp. */
  fillRatePct: string;
  /** What the platform payout file says it settled for this line. */
  payoutQty: string;
  payoutAmountPaise: number;
  /** Non-null only when payout and acceptance disagree. */
  payoutVariance: string | null;
}

export interface UnmatchedPayoutLine {
  id: number;
  payoutRef: string;
  providerPoNumber: string | null;
  providerSku: string | null;
  ean: string | null;
  quantity: string;
  amountPaise: number;
  unmatchedReason: string | null;
}

export interface FillRateReport {
  platformPoId: number;
  provider: string;
  providerPoNumber: string;
  status: string;
  warehouseId: number | null;
  orderedQty: string;
  acceptedQty: string;
  fillRatePct: string;
  lines: FillRateLine[];
  /**
   * Payout lines this report could not place. Listed rather than dropped: an
   * unmatched payout line is the platform paying for something we have no record
   * of shipping, and it is the whole reason to run the reconciliation.
   */
  unmatchedPayoutLines: UnmatchedPayoutLine[];
}

export async function report(
  deps: FillRateReportDeps,
  orgId: string,
  userId: string,
  query: FillRateQuery,
): Promise<FillRateReport> {
  const [header] = await deps.db
    .select({
      id: invPlatformPurchaseOrders.id,
      provider: invPlatformPurchaseOrders.provider,
      providerPoNumber: invPlatformPurchaseOrders.providerPoNumber,
      status: invPlatformPurchaseOrders.status,
      warehouseId: invPlatformPurchaseOrders.warehouseId,
      poId: invPlatformPurchaseOrders.poId,
    })
    .from(invPlatformPurchaseOrders)
    .where(
      and(
        eq(invPlatformPurchaseOrders.orgId, orgId),
        eq(invPlatformPurchaseOrders.id, query.platformPoId),
      ),
    );
  if (!header) throw new NotFoundException("Not found");

  // Warehouse-scoped like every other operational read: a supervisor who
  // cannot see a site's stock may not see its fill rate either.
  if (header.warehouseId !== null) {
    await deps.warehouseScope.assertWarehouseVisible(orgId, userId, header.warehouseId);
  }

  const lines = await deps.db
    .select({
      id: invPlatformPoLines.id,
      productVariantId: invPlatformPoLines.productVariantId,
      providerSku: invPlatformPoLines.providerSku,
      ean: invPlatformPoLines.ean,
      quantityOrdered: invPlatformPoLines.quantityOrdered,
    })
    .from(invPlatformPoLines)
    .where(
      and(
        eq(invPlatformPoLines.orgId, orgId),
        eq(invPlatformPoLines.platformPoId, query.platformPoId),
      ),
    )
    .orderBy(asc(invPlatformPoLines.lineOrder));

  const received =
    header.poId === null ? new Map<number, string>() : await receivedByVariant(deps.db, orgId, header.poId);
  const shipped = await shippedByVariant(deps.db, orgId, query.platformPoId);
  const returned = await returnedByVariant(deps.db, orgId, query.platformPoId);
  const payouts = await payoutsFor(deps.db, orgId, header.provider, header.providerPoNumber);

  const payoutByLine = new Map<number, { qty: string; amountPaise: number }>();
  for (const payout of payouts) {
    if (payout.platformPoLineId === null) continue;
    const current = payoutByLine.get(payout.platformPoLineId) ?? { qty: "0", amountPaise: 0 };
    payoutByLine.set(payout.platformPoLineId, {
      qty: addDec(current.qty, payout.quantity),
      amountPaise: current.amountPaise + payout.amountPaise,
    });
  }

  let totalOrdered = "0";
  let totalAccepted = "0";

  const reportLines: FillRateLine[] = lines.map((line) => {
    const variantId = line.productVariantId;
    const shippedQty = variantId === null ? "0.0000" : shipped.get(variantId) ?? "0.0000";
    const returnedQty = variantId === null ? "0.0000" : returned.get(variantId) ?? "0.0000";
    const acceptedQty = clampAtZero(subDec(shippedQty, returnedQty));
    const payout = payoutByLine.get(line.id) ?? { qty: "0.0000", amountPaise: 0 };

    totalOrdered = addDec(totalOrdered, line.quantityOrdered);
    totalAccepted = addDec(totalAccepted, acceptedQty);

    return {
      platformPoLineId: line.id,
      productVariantId: variantId,
      providerSku: line.providerSku,
      ean: line.ean,
      orderedQty: line.quantityOrdered,
      receivedQty: variantId === null ? "0.0000" : received.get(variantId) ?? "0.0000",
      shippedQty,
      returnedQty,
      acceptedQty,
      fillRatePct: percentage(acceptedQty, line.quantityOrdered),
      payoutQty: payout.qty,
      payoutAmountPaise: payout.amountPaise,
      // Reported only when they actually disagree, so a clean line stays quiet
      // and the eye goes to the ones that do not.
      payoutVariance:
        cmpDec(payout.qty, "0") === 0 || cmpDec(payout.qty, acceptedQty) === 0
          ? null
          : subDec(payout.qty, acceptedQty),
    };
  });

  return {
    platformPoId: header.id,
    provider: header.provider,
    providerPoNumber: header.providerPoNumber,
    status: header.status,
    warehouseId: header.warehouseId,
    orderedQty: totalOrdered,
    acceptedQty: totalAccepted,
    fillRatePct: percentage(totalAccepted, totalOrdered),
    lines: reportLines,
    unmatchedPayoutLines: payouts
      .filter((p) => p.platformPoLineId === null)
      .map((p) => ({
        id: p.id,
        payoutRef: p.payoutRef,
        providerPoNumber: p.providerPoNumber,
        providerSku: p.providerSku,
        ean: p.ean,
        quantity: p.quantity,
        amountPaise: p.amountPaise,
        unmatchedReason: p.unmatchedReason,
      })),
  };
}

/** What actually arrived against the Streamline purchase order this PO raised. */
async function receivedByVariant(db: Db, orgId: string, poId: number): Promise<Map<number, string>> {
  const rows = await db.execute<{ product_variant_id: number; qty: string }>(sql`
    SELECT pol.product_variant_id, COALESCE(SUM(gl.quantity_received), 0)::text AS qty
    FROM inv_grn_lines gl
    JOIN inv_grns g ON g.id = gl.grn_id AND g.org_id = gl.org_id
    JOIN inv_po_lines pol ON pol.id = gl.po_line_id AND pol.org_id = gl.org_id
    WHERE gl.org_id = ${orgId} AND pol.po_id = ${poId}
      AND g.status = 'POSTED' AND gl.quality_status = 'ACCEPTED'
    GROUP BY pol.product_variant_id
  `);
  return new Map(rows.map((r) => [Number(r.product_variant_id), String(r.qty)]));
}

/**
 * What we shipped back out against this platform order.
 *
 * Joined on `inv_sales_orders.platform_po_id`, a real foreign key, rather than
 * by matching dates and channels: a fill-rate number assembled from a guess is
 * a number nobody in the room will act on.
 */
async function shippedByVariant(db: Db, orgId: string, platformPoId: number): Promise<Map<number, string>> {
  const rows = await db.execute<{ product_variant_id: number; qty: string }>(sql`
    SELECT sl.product_variant_id, COALESCE(SUM(sl.quantity_shipped), 0)::text AS qty
    FROM inv_so_lines sl
    JOIN inv_sales_orders so ON so.id = sl.so_id AND so.org_id = sl.org_id
    WHERE sl.org_id = ${orgId} AND so.platform_po_id = ${platformPoId}
    GROUP BY sl.product_variant_id
  `);
  return new Map(rows.map((r) => [Number(r.product_variant_id), String(r.qty)]));
}

async function returnedByVariant(db: Db, orgId: string, platformPoId: number): Promise<Map<number, string>> {
  const rows = await db.execute<{ product_variant_id: number; qty: string }>(sql`
    SELECT crl.product_variant_id, COALESCE(SUM(crl.quantity), 0)::text AS qty
    FROM inv_customer_return_lines crl
    JOIN inv_customer_returns cr ON cr.id = crl.return_id AND cr.org_id = crl.org_id
    JOIN inv_sales_orders so ON so.id = cr.so_id AND so.org_id = cr.org_id
    WHERE crl.org_id = ${orgId} AND so.platform_po_id = ${platformPoId}
    GROUP BY crl.product_variant_id
  `);
  return new Map(rows.map((r) => [Number(r.product_variant_id), String(r.qty)]));
}

async function payoutsFor(db: Db, orgId: string, provider: string, providerPoNumber: string) {
  return db
    .select()
    .from(invPlatformPayoutLines)
    .where(
      and(
        eq(invPlatformPayoutLines.orgId, orgId),
        sql`${invPlatformPayoutLines.provider} = ${provider}`,
        sql`(${invPlatformPayoutLines.providerPoNumber} = ${providerPoNumber} OR ${invPlatformPayoutLines.providerPoNumber} IS NULL)`,
      ),
    );
}

function clampAtZero(value: string): string {
  return cmpDec(value, "0") < 0 ? "0.0000" : value;
}

/**
 * A percentage, exact.
 *
 * `divDec` then `mulDec`, never `Number(a) / Number(b) * 100`: a fill rate is
 * quoted back to a platform and argued over, and the one thing it must not be is
 * a float that disagrees with the arithmetic somebody did by hand.
 *
 * Zero ordered is `0.0000`, not a division by zero and not 100 - a purchase
 * order with nothing on it has no fill rate, and a perfect one would put a green
 * number beside a document that never asked for anything.
 */
export function percentage(part: string, whole: string): string {
  if (cmpDec(whole, "0") <= 0) return "0.0000";
  return mulDec(divDec(part, whole), "100");
}
