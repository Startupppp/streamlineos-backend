import { and, eq, lte, sql } from "drizzle-orm";
import { invLots, invProductVariants, invPurchaseOrders, invVendors } from "../../../../../db/schema";
import type { InvCopilotToolName } from "../dto/inv-copilot.schemas";
import {
  COPILOT_ROW_CAP,
  EMPTY,
  evidenceFrom,
  takeCapped,
  text,
  type ToolDefinition,
} from "./copilot-tool-helpers";

/** Moved with `expiring_lots`, its only reader. */
const EXPIRY_WINDOW_DAYS = 30;

/**
 * The supply-side copilot tools — what is about to expire, and which vendors run
 * late. Split out of `inv-copilot-tools.ts` unchanged so that file can hold the
 * stock-side table without running past the size limit.
 *
 * `satisfies` rather than an annotation, so these stay checked against
 * `ToolDefinition` while the full `Record<InvCopilotToolName, ...>` completeness
 * check remains on the composed table in the parent file — a partial annotation
 * here would have silently made that completeness check unenforceable.
 */
export const INV_COPILOT_SUPPLY_TOOLS = {
  expiring_lots: {
    label: `Lots expiring within ${EXPIRY_WINDOW_DAYS} days`,
    description:
      "Lots with stock still on hand whose expiry date is close. Answers 'what is about to go out of date'.",
    columns: ["lotNumber", "sku", "expiryDate", "onHand"],
    async run(ctx) {
      if (ctx.scope.isEmpty) return { ...EMPTY, rows: [], evidence: [] };
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + EXPIRY_WINDOW_DAYS);
      const cutoff = horizon.toISOString().slice(0, 10);

      // A lot has no warehouse of its own; it is wherever its stock is. So the
      // gate rides on the stock rows, and the same subquery supplies the
      // quantity — a lot whose only stock sits outside the asker's warehouses
      // sums to zero and drops out with everything else that has none.
      const scopedOnHand = sql<string>`COALESCE((
        SELECT SUM(sl.on_hand::numeric)
        FROM inv_stock_levels sl
        WHERE sl.lot_id = ${invLots.id}
          AND sl.org_id = ${ctx.orgId}
          AND ${ctx.scope.location(sql`sl.location_id`)}
      ), 0)`;

      const rows = await ctx.db
        .select({
          lotId: invLots.id,
          lotNumber: invLots.lotNumber,
          variantId: invLots.productVariantId,
          sku: invProductVariants.sku,
          expiryDate: invLots.expiryDate,
          onHand: sql<string>`${scopedOnHand}::text`,
        })
        .from(invLots)
        .innerJoin(
          invProductVariants,
          and(
            eq(invProductVariants.id, invLots.productVariantId),
            eq(invProductVariants.orgId, invLots.orgId),
          ),
        )
        .where(
          and(
            eq(invLots.orgId, ctx.orgId),
            lte(invLots.expiryDate, cutoff),
            sql`${scopedOnHand} > 0`,
            ...(ctx.focus.variantId ? [eq(invLots.productVariantId, ctx.focus.variantId)] : []),
          ),
        )
        .orderBy(invLots.expiryDate)
        .limit(COPILOT_ROW_CAP + 1);

      const { page, truncated } = takeCapped(rows);
      return {
        truncated,
        rows: page.map((r) => ({
          // A lot number is tenant free-text and arrives here bounded. It is
          // rendered as a value in a table cell and quoted as data in the
          // narration prompt; it never becomes an instruction.
          lotNumber: text(r.lotNumber),
          sku: text(r.sku),
          expiryDate: r.expiryDate,
          onHand: r.onHand,
        })),
        evidence: evidenceFrom(
          page.flatMap((r) => [
            ["lot", r.lotId] as const,
            ["product_variant", r.variantId] as const,
          ]),
        ),
      };
    },
  },

  vendor_delay: {
    label: "Overdue supplier deliveries",
    description:
      "Open purchase orders past their expected delivery date, by vendor, with how many days late. Answers 'which supplier is holding us up'.",
    columns: ["vendor", "poNumber", "expectedDelivery", "daysLate"],
    async run(ctx) {
      if (ctx.scope.isEmpty) return { ...EMPTY, rows: [], evidence: [] };
      const today = new Date().toISOString().slice(0, 10);

      const rows = await ctx.db
        .select({
          poId: invPurchaseOrders.id,
          poNumber: invPurchaseOrders.poNumber,
          vendorId: invPurchaseOrders.vendorId,
          vendor: invVendors.name,
          warehouseId: invPurchaseOrders.warehouseId,
          expectedDelivery: invPurchaseOrders.expectedDeliveryDate,
          // Computed in Postgres against the same `today` the predicate uses, so
          // the figure and the filter cannot disagree, and so the model is never
          // asked to subtract two dates.
          daysLate: sql<number>`(${today}::date - ${invPurchaseOrders.expectedDeliveryDate}::date)::int`,
        })
        .from(invPurchaseOrders)
        .innerJoin(
          invVendors,
          and(
            eq(invVendors.id, invPurchaseOrders.vendorId),
            eq(invVendors.orgId, invPurchaseOrders.orgId),
          ),
        )
        .where(
          and(
            eq(invPurchaseOrders.orgId, ctx.orgId),
            sql`${invPurchaseOrders.status} IN ('SENT', 'PARTIAL')`,
            sql`${invPurchaseOrders.expectedDeliveryDate} < ${today}`,
            ctx.scope.warehouse(sql`${invPurchaseOrders.warehouseId}`),
            ...(ctx.focus.vendorId ? [eq(invPurchaseOrders.vendorId, ctx.focus.vendorId)] : []),
            ...(ctx.focus.warehouseId
              ? [eq(invPurchaseOrders.warehouseId, ctx.focus.warehouseId)]
              : []),
          ),
        )
        .orderBy(invPurchaseOrders.expectedDeliveryDate)
        .limit(COPILOT_ROW_CAP + 1);

      const { page, truncated } = takeCapped(rows);
      return {
        truncated,
        rows: page.map((r) => ({
          vendor: text(r.vendor),
          poNumber: text(r.poNumber),
          expectedDelivery: r.expectedDelivery,
          daysLate: r.daysLate,
        })),
        evidence: evidenceFrom(
          page.flatMap((r) => [
            ["purchase_order", r.poId] as const,
            ["vendor", r.vendorId] as const,
            ["warehouse", r.warehouseId] as const,
          ]),
        ),
      };
    },
  },
} satisfies Partial<Record<InvCopilotToolName, ToolDefinition>>;
