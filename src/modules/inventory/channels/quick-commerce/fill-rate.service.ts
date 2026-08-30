import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  invPlatformPayoutLines,
  invPlatformPoLines,
  invPlatformPurchaseOrders,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { addDec, cmpDec, divDec, mulDec, subDec } from "../../stock-engine/decimal";
import type { FillRateQuery, UploadPayoutInput } from "./dto/quick-commerce.schemas";

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

/**
 * NEO-3 - did we ship what the platform ordered, and did they pay for it.
 *
 * Three numbers a quick-commerce seller is judged on, and Streamline could
 * answer none of them: ordered, accepted, settled. Fill rate is the platform's
 * own scorecard - miss it and the listing is throttled - so a seller who cannot
 * see it before the platform tells them is finding out too late.
 *
 * **This writes nothing to the general ledger, and it is not a bank
 * reconciliation.** It compares three documents we already hold: what the
 * platform ordered, what our own sales orders shipped against it, and what the
 * platform's uploaded payout file says. Where they disagree it says so and names
 * the line. Turning that into a journal entry is accounting's work and would
 * need a real settlement account, which this has no business inventing.
 */
@Injectable()
export class FillRateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async report(orgId: string, userId: string, query: FillRateQuery): Promise<FillRateReport> {
    const [header] = await this.db
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
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, header.warehouseId);
    }

    const lines = await this.db
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
      header.poId === null ? new Map<number, string>() : await this.receivedByVariant(orgId, header.poId);
    const shipped = await this.shippedByVariant(orgId, query.platformPoId);
    const returned = await this.returnedByVariant(orgId, query.platformPoId);
    const payouts = await this.payoutsFor(orgId, header.provider, header.providerPoNumber);

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
  private async receivedByVariant(orgId: string, poId: number): Promise<Map<number, string>> {
    const rows = await this.db.execute<{ product_variant_id: number; qty: string }>(sql`
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
  private async shippedByVariant(orgId: string, platformPoId: number): Promise<Map<number, string>> {
    const rows = await this.db.execute<{ product_variant_id: number; qty: string }>(sql`
      SELECT sl.product_variant_id, COALESCE(SUM(sl.quantity_shipped), 0)::text AS qty
      FROM inv_so_lines sl
      JOIN inv_sales_orders so ON so.id = sl.so_id AND so.org_id = sl.org_id
      WHERE sl.org_id = ${orgId} AND so.platform_po_id = ${platformPoId}
      GROUP BY sl.product_variant_id
    `);
    return new Map(rows.map((r) => [Number(r.product_variant_id), String(r.qty)]));
  }

  private async returnedByVariant(orgId: string, platformPoId: number): Promise<Map<number, string>> {
    const rows = await this.db.execute<{ product_variant_id: number; qty: string }>(sql`
      SELECT crl.product_variant_id, COALESCE(SUM(crl.quantity), 0)::text AS qty
      FROM inv_customer_return_lines crl
      JOIN inv_customer_returns cr ON cr.id = crl.return_id AND cr.org_id = crl.org_id
      JOIN inv_sales_orders so ON so.id = cr.so_id AND so.org_id = cr.org_id
      WHERE crl.org_id = ${orgId} AND so.platform_po_id = ${platformPoId}
      GROUP BY crl.product_variant_id
    `);
    return new Map(rows.map((r) => [Number(r.product_variant_id), String(r.qty)]));
  }

  private async payoutsFor(orgId: string, provider: string, providerPoNumber: string) {
    return this.db
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

  /**
   * Take a platform payout file.
   *
   * Uploaded, not fetched: there is no connected account, and pretending
   * otherwise is the failure this programme keeps being burnt by. Every row is
   * matched against a platform PO line by (provider PO number, SKU or EAN), and
   * the ones that do not match are stored **unmatched, with the reason** - they
   * are the output somebody has to act on, and a matcher that silently dropped
   * what it could not place would hide exactly those lines.
   *
   * Re-uploading the same file is a no-op: `uniq_inv_platform_payout_line_key`
   * is the fence, and a settlement counted twice is worse than one counted late.
   */
  async uploadPayout(orgId: string, userId: string, input: UploadPayoutInput) {
    if (input.lines.length === 0) throw new BadRequestException("The payout file has no lines");

    const poNumbers = [
      ...new Set(input.lines.map((l) => l.providerPoNumber).filter((v): v is string => Boolean(v))),
    ];
    const candidates =
      poNumbers.length === 0
        ? []
        : await this.db
            .select({
              lineId: invPlatformPoLines.id,
              providerSku: invPlatformPoLines.providerSku,
              ean: invPlatformPoLines.ean,
              providerPoNumber: invPlatformPurchaseOrders.providerPoNumber,
            })
            .from(invPlatformPoLines)
            .innerJoin(
              invPlatformPurchaseOrders,
              and(
                eq(invPlatformPurchaseOrders.orgId, invPlatformPoLines.orgId),
                eq(invPlatformPurchaseOrders.id, invPlatformPoLines.platformPoId),
              ),
            )
            .where(
              and(
                eq(invPlatformPoLines.orgId, orgId),
                sql`${invPlatformPurchaseOrders.provider} = ${input.provider}`,
                inArray(invPlatformPurchaseOrders.providerPoNumber, poNumbers),
              ),
            );

    const bySku = new Map<string, number>();
    const byEan = new Map<string, number>();
    for (const row of candidates) {
      if (row.providerSku) bySku.set(`${row.providerPoNumber}::${row.providerSku}`, row.lineId);
      if (row.ean) byEan.set(`${row.providerPoNumber}::${row.ean}`, row.lineId);
    }

    const values = input.lines.map((line) => {
      const poNumber = line.providerPoNumber ?? "";
      const matched =
        (line.providerSku ? bySku.get(`${poNumber}::${line.providerSku}`) : undefined) ??
        (line.ean ? byEan.get(`${poNumber}::${line.ean}`) : undefined) ??
        null;

      return {
        orgId,
        provider: input.provider,
        payoutRef: input.payoutRef,
        providerPoNumber: line.providerPoNumber ?? null,
        providerSku: line.providerSku ?? null,
        ean: line.ean ?? null,
        quantity: line.quantity,
        amountPaise: line.amountPaise,
        settledOn: input.settledOn ?? null,
        platformPoLineId: matched,
        unmatchedReason:
          matched !== null
            ? null
            : !line.providerPoNumber
              ? "The payout line names no purchase order"
              : `No line on ${line.providerPoNumber} carries ${line.providerSku ?? line.ean ?? "this item"}`,
        createdBy: userId,
      };
    });

    const inserted = await this.db
      .insert(invPlatformPayoutLines)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: invPlatformPayoutLines.id, platformPoLineId: invPlatformPayoutLines.platformPoLineId });

    const unmatched = inserted.filter((r) => r.platformPoLineId === null).length;

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "platform_payout.upload",
      resourceType: "inv_platform_payout",
      resourceId: input.payoutRef,
      after: { provider: input.provider, lines: inserted.length, unmatched },
      metadata: { submitted: input.lines.length, duplicatesIgnored: input.lines.length - inserted.length },
    });

    return {
      payoutRef: input.payoutRef,
      submitted: input.lines.length,
      stored: inserted.length,
      duplicatesIgnored: input.lines.length - inserted.length,
      unmatched,
    };
  }
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
