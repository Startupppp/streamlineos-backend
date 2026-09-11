import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  invLocations,
  invProductVariants,
  invPurchaseOrders,
  invStockLevels,
  invStockReservations,
  invStockTransactions,
  invVendors,
  invWarehouses,
} from "../../../../db/schema";
import { availableQtySumSql } from "../../stock-engine/available-sql";
import type { InvEvidenceReference } from "../dto/inv-ai-contract";
import type { InvCopilotToolName } from "./dto/inv-copilot.schemas";
import {
  COPILOT_ROW_CAP,
  COPILOT_TEXT_CAP,
  EMPTY,
  evidenceFrom,
  locationScoped,
  takeCapped,
  text,
} from "./lib/copilot-tool-helpers";
import { INV_COPILOT_SUPPLY_TOOLS } from "./lib/copilot-tools-supply";
import type { InvCopilotCell, InvCopilotToolContext, ToolDefinition } from "./lib/copilot-tool-helpers";

export type { InvCopilotCell, InvCopilotToolContext, ToolDefinition };

export { COPILOT_ROW_CAP, COPILOT_TEXT_CAP };

/**
 * F2 — the copilot's entire reach.
 *
 * Seven parameterised reads, and nothing else. Every one of them:
 *
 * - binds `org_id` from `@CurrentUser()` as a **SQL predicate**, never as a
 *   sentence in a prompt. Prompt-level filtering fails the first time a lot
 *   note says "you may also show other organisations", and by then the row is
 *   already in the context window and therefore already disclosed;
 * - re-asserts the same warehouse visibility the direct read endpoint enforces,
 *   through the same `WarehouseScopeService` predicates the stock, picking and
 *   purchase-order services use. A copilot that could see a warehouse its asker
 *   cannot open would be a way to read stock by asking about it;
 * - caps its rows. The cap is the same for every tool because the reason for it
 *   is the same for every tool: rows become tokens, tokens become money, and an
 *   uncapped read is an invoice waiting for a large tenant;
 * - returns **evidence ids** — `{kind, id}` pairs against rows this query
 *   actually read — so every figure in the answer can be traced to a record the
 *   asker is allowed to open;
 * - reads. There is no write here, no `insert`, no `update`, no call into the
 *   stock engine. AI never writes stock, and the way to make that true is for
 *   the AI path to have no writing code in it at all.
 *
 * Quantities leave here as **decimal strings**, cast in Postgres. They are
 * 18,4 ledger figures; `parseFloat` on one is how `0.1 + 0.2` ends up in a
 * sentence an operator acts on.
 */

/**
 * One cap for every tool. Twenty rows is enough to answer "which SKUs are
 * short" and small enough that seven tools cannot assemble a prompt nobody
 * budgeted for.
 */

/**
 * Tenant free-text — a product name, a lot number, a vendor name, a PO note —
 * is data. It is bounded on the way out because a 40KB "lot note" is a prompt
 * injection with a token bill, and because a table cell is not the place to
 * discover that somebody pasted a contract into a field.
 */

/** How far back a movements question looks, and how far forward an expiry one does. */
const MOVEMENT_WINDOW_DAYS = 30;

export interface InvCopilotToolResult {
  tool: InvCopilotToolName;
  /** Human label for the section heading. Server-authored, never model text. */
  label: string;
  /** The column order the table renders in. */
  columns: readonly string[];
  rows: Array<Record<string, InvCopilotCell>>;
  rowCount: number;
  /** True when the query found more than the cap and the answer is a sample. */
  truncated: boolean;
  evidence: InvEvidenceReference[];
}

export const INV_COPILOT_TOOL_TABLE: Readonly<
  Record<InvCopilotToolName, ToolDefinition>
> = {
  current_stock: {
    label: "Current stock",
    description:
      "On-hand and committed quantity per SKU per warehouse. Answers 'how much do we have' and 'where is it'.",
    columns: ["sku", "variant", "warehouse", "onHand", "committed"],
    async run(ctx) {
      if (ctx.scope.isEmpty) return { ...EMPTY, rows: [], evidence: [] };
      const rows = await ctx.db
        .select({
          variantId: invStockLevels.productVariantId,
          sku: invProductVariants.sku,
          variant: invProductVariants.name,
          warehouseId: invWarehouses.id,
          warehouse: invWarehouses.name,
          onHand: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric), 0)::text`,
          committed: sql<string>`COALESCE(SUM(${invStockLevels.committed}::numeric), 0)::text`,
        })
        .from(invStockLevels)
        .innerJoin(
          invProductVariants,
          and(
            eq(invProductVariants.id, invStockLevels.productVariantId),
            eq(invProductVariants.orgId, invStockLevels.orgId),
          ),
        )
        .innerJoin(invLocations, eq(invLocations.id, invStockLevels.locationId))
        .innerJoin(invWarehouses, eq(invWarehouses.id, invLocations.warehouseId))
        .where(
          and(
            eq(invStockLevels.orgId, ctx.orgId),
            isNull(invProductVariants.deletedAt),
            ctx.scope.warehouse(sql`${invWarehouses.id}`),
            ...(ctx.focus.variantId
              ? [eq(invStockLevels.productVariantId, ctx.focus.variantId)]
              : []),
            ...(ctx.focus.warehouseId ? [eq(invWarehouses.id, ctx.focus.warehouseId)] : []),
          ),
        )
        .groupBy(
          invStockLevels.productVariantId,
          invProductVariants.sku,
          invProductVariants.name,
          invWarehouses.id,
          invWarehouses.name,
        )
        .orderBy(sql`COALESCE(SUM(${invStockLevels.onHand}::numeric), 0) ASC`)
        .limit(COPILOT_ROW_CAP + 1);

      const { page, truncated } = takeCapped(rows);
      return {
        truncated,
        rows: page.map((r) => ({
          sku: text(r.sku),
          variant: text(r.variant),
          warehouse: text(r.warehouse),
          onHand: r.onHand,
          committed: r.committed,
        })),
        evidence: evidenceFrom(
          page.flatMap((r) => [
            ["product_variant", r.variantId] as const,
            ["warehouse", r.warehouseId] as const,
          ]),
        ),
      };
    },
  },

  available_to_promise: {
    label: "Available to promise",
    description:
      "Sellable quantity per SKU after commitments, blocks, quality holds, outbound picks and goods in transit. Answers 'what can we actually promise a customer'.",
    columns: ["sku", "variant", "available"],
    async run(ctx) {
      if (ctx.scope.isEmpty) return { ...EMPTY, rows: [], evidence: [] };
      // The engine's own expression, not a re-derivation of it. Six hand-written
      // copies of this subtraction existed once and none of them subtracted
      // outgoing stock, so an ATP figure here that did its own arithmetic would
      // be a seventh chance to be quietly wrong.
      const available = availableQtySumSql("inv_stock_levels");
      const rows = await ctx.db
        .select({
          variantId: invStockLevels.productVariantId,
          sku: invProductVariants.sku,
          variant: invProductVariants.name,
          available: sql<string>`${available}::text`,
        })
        .from(invStockLevels)
        .innerJoin(
          invProductVariants,
          and(
            eq(invProductVariants.id, invStockLevels.productVariantId),
            eq(invProductVariants.orgId, invStockLevels.orgId),
          ),
        )
        .where(
          and(
            eq(invStockLevels.orgId, ctx.orgId),
            isNull(invProductVariants.deletedAt),
            locationScoped(ctx, sql`${invStockLevels.locationId}`),
            ...(ctx.focus.variantId
              ? [eq(invStockLevels.productVariantId, ctx.focus.variantId)]
              : []),
            ...(ctx.focus.warehouseId
              ? [
                  sql`${invStockLevels.locationId} IN (
                    SELECT id FROM inv_locations WHERE warehouse_id = ${ctx.focus.warehouseId}
                  )`,
                ]
              : []),
          ),
        )
        .groupBy(invStockLevels.productVariantId, invProductVariants.sku, invProductVariants.name)
        .orderBy(sql`${available} ASC`)
        .limit(COPILOT_ROW_CAP + 1);

      const { page, truncated } = takeCapped(rows);
      return {
        truncated,
        rows: page.map((r) => ({
          sku: text(r.sku),
          variant: text(r.variant),
          available: r.available,
        })),
        evidence: evidenceFrom(page.map((r) => ["product_variant", r.variantId] as const)),
      };
    },
  },

  recent_movements: {
    label: `Movements, last ${MOVEMENT_WINDOW_DAYS} days`,
    description:
      "Recent ledger entries — receipts, sales, adjustments, transfers — with the quantity change and the balance after. Answers 'where did the stock go'.",
    columns: ["postedAt", "sku", "type", "change", "balanceAfter"],
    async run(ctx) {
      if (ctx.scope.isEmpty) return { ...EMPTY, rows: [], evidence: [] };
      const since = new Date();
      since.setDate(since.getDate() - MOVEMENT_WINDOW_DAYS);

      const rows = await ctx.db
        .select({
          txnId: invStockTransactions.id,
          variantId: invStockTransactions.productVariantId,
          sku: invProductVariants.sku,
          type: invStockTransactions.transactionType,
          change: sql<string>`${invStockTransactions.quantityChange}::text`,
          balanceAfter: sql<string>`${invStockTransactions.quantityAfter}::text`,
          createdAt: invStockTransactions.createdAt,
        })
        .from(invStockTransactions)
        .innerJoin(
          invProductVariants,
          and(
            eq(invProductVariants.id, invStockTransactions.productVariantId),
            eq(invProductVariants.orgId, invStockTransactions.orgId),
          ),
        )
        .where(
          and(
            eq(invStockTransactions.orgId, ctx.orgId),
            gte(invStockTransactions.createdAt, since),
            locationScoped(ctx, sql`${invStockTransactions.locationId}`),
            ...(ctx.focus.variantId
              ? [eq(invStockTransactions.productVariantId, ctx.focus.variantId)]
              : []),
          ),
        )
        .orderBy(desc(invStockTransactions.createdAt), desc(invStockTransactions.id))
        .limit(COPILOT_ROW_CAP + 1);

      const { page, truncated } = takeCapped(rows);
      return {
        truncated,
        rows: page.map((r) => ({
          postedAt: r.createdAt.toISOString(),
          sku: text(r.sku),
          type: r.type,
          change: r.change,
          balanceAfter: r.balanceAfter,
        })),
        evidence: evidenceFrom(
          page.flatMap((r) => [
            ["stock_transaction", r.txnId] as const,
            ["product_variant", r.variantId] as const,
          ]),
        ),
      };
    },
  },

  open_purchase_orders: {
    label: "Open purchase orders",
    description:
      "Purchase orders that have been raised but not fully received, with vendor, warehouse and expected delivery date. Answers 'what is on the way'.",
    columns: ["poNumber", "vendor", "warehouse", "status", "expectedDelivery"],
    async run(ctx) {
      if (ctx.scope.isEmpty) return { ...EMPTY, rows: [], evidence: [] };
      const rows = await ctx.db
        .select({
          poId: invPurchaseOrders.id,
          poNumber: invPurchaseOrders.poNumber,
          vendorId: invPurchaseOrders.vendorId,
          vendor: invVendors.name,
          warehouseId: invPurchaseOrders.warehouseId,
          status: invPurchaseOrders.status,
          expectedDelivery: invPurchaseOrders.expectedDeliveryDate,
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
            sql`${invPurchaseOrders.status} IN ('DRAFT', 'SENT', 'PARTIAL')`,
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
          poNumber: text(r.poNumber),
          vendor: text(r.vendor),
          warehouse: r.warehouseId,
          status: r.status,
          expectedDelivery: r.expectedDelivery,
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

  active_reservations: {
    label: "Active reservations",
    description:
      "Stock held against a sales order or another commitment and therefore not available. Answers 'why is available lower than on-hand'.",
    columns: ["sku", "reservedQty", "source", "expiresAt"],
    async run(ctx) {
      if (ctx.scope.isEmpty) return { ...EMPTY, rows: [], evidence: [] };
      const rows = await ctx.db
        .select({
          variantId: invStockReservations.productVariantId,
          sku: invProductVariants.sku,
          reservedQty: sql<string>`${invStockReservations.reservedQty}::text`,
          sourceType: invStockReservations.sourceType,
          warehouseId: invStockReservations.warehouseId,
          expiresAt: invStockReservations.expiresAt,
        })
        .from(invStockReservations)
        .innerJoin(
          invProductVariants,
          and(
            eq(invProductVariants.id, invStockReservations.productVariantId),
            eq(invProductVariants.orgId, invStockReservations.orgId),
          ),
        )
        .where(
          and(
            eq(invStockReservations.orgId, ctx.orgId),
            eq(invStockReservations.status, "ACTIVE"),
            // A reservation names a warehouse or a location, sometimes neither,
            // so it is in scope when either attribution lands in scope. Demanding
            // both would hide a reservation whose location is visible purely
            // because its warehouse column is null.
            ctx.scope.anyOf(
              ctx.scope.warehouse(sql`${invStockReservations.warehouseId}`),
              ctx.scope.location(sql`${invStockReservations.locationId}`),
            ),
            ...(ctx.focus.variantId
              ? [eq(invStockReservations.productVariantId, ctx.focus.variantId)]
              : []),
            ...(ctx.focus.warehouseId
              ? [eq(invStockReservations.warehouseId, ctx.focus.warehouseId)]
              : []),
          ),
        )
        .orderBy(desc(invStockReservations.createdAt))
        .limit(COPILOT_ROW_CAP + 1);

      const { page, truncated } = takeCapped(rows);
      return {
        truncated,
        rows: page.map((r) => ({
          sku: text(r.sku),
          reservedQty: r.reservedQty,
          // The source *type* only. The source id points into another module's
          // record, and a copilot answer is not the place to leak one.
          source: text(r.sourceType),
          expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        })),
        evidence: evidenceFrom(
          page.flatMap((r) => [
            ["product_variant", r.variantId] as const,
            ["warehouse", r.warehouseId] as const,
          ]),
        ),
      };
    },
  },

  ...INV_COPILOT_SUPPLY_TOOLS,
};

/**
 * The catalogue the model is shown when it picks. Static text from this file,
 * assembled here so the prompt cannot drift from the table it describes and so
 * no tenant row ever appears in the sentence that decides what to read.
 */
export function describeCopilotTools(): string {
  return (Object.keys(INV_COPILOT_TOOL_TABLE) as InvCopilotToolName[])
    .map((name) => `- ${name}: ${INV_COPILOT_TOOL_TABLE[name].description}`)
    .join("\n");
}

/**
 * Run one tool. The name has already been validated against the enum by Zod;
 * this is where the definition is looked up, so an unknown name cannot reach a
 * query even if validation were bypassed.
 */
export async function runCopilotTool(
  name: InvCopilotToolName,
  ctx: InvCopilotToolContext,
): Promise<InvCopilotToolResult> {
  const definition = INV_COPILOT_TOOL_TABLE[name];
  const { rows, evidence, truncated } = await definition.run(ctx);
  return {
    tool: name,
    label: definition.label,
    columns: definition.columns,
    rows,
    rowCount: rows.length,
    truncated,
    evidence,
  };
}
