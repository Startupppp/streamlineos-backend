import { and, eq, sql } from "drizzle-orm";
import {
  invReorderRules,
  invStockLevels,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../../common/cache/cache-keys";
import { addDec, cmpDec, subDec } from "../../stock-engine/decimal";
import { atLeastZero, fromExact } from "./../forecast/exact";
import type { SuggestionsQueryInput } from "../dto/replenishment.schemas";

/**
 * The three replenishment reads — suggestions for a warehouse, the suggestion for
 * one variant, and the forecast — lifted out of `inv-replenishment.service.ts`
 * unchanged.
 *
 * Each used only the db handle and (for `getSuggestions`) the cache, so those
 * arrive as parameters. `getSuggestions` and `getForecasting` are public API with
 * live controller callers, so the service keeps a three-line delegate for each
 * rather than moving the route surface; the bulk that made the file long is the
 * part that had no reason to be a method.
 */
export async function getSuggestions(
  db: Db,
  cache: CacheService,
  orgId: string,
  filters: SuggestionsQueryInput,
) {
    const { page, limit } = filters;
    return cache.cachedVersioned(
      CACHE_KEYS.invReplenishmentSuggestionsNamespace(orgId),
      `${page}:${limit}`,
      async () => {
        const [rules, stockRows] = await Promise.all([
          db.query.invReorderRules.findMany({
            where: and(eq(invReorderRules.orgId, orgId), eq(invReorderRules.isActive, true)),
            with: {
              productVariant: { with: { product: { columns: { id: true, name: true, sku: true, defaultVendorId: true } } } },
              warehouse: { columns: { id: true, name: true } },
            },
            limit: 500,
          }),
          db
            .select({
              variantId: invStockLevels.productVariantId,
              onHand: sql<string>`SUM(${invStockLevels.onHand}::numeric)::text`,
              onOrder: sql<string>`SUM(${invStockLevels.onOrder}::numeric)::text`,
              outgoing: sql<string>`SUM(${invStockLevels.outgoingQty}::numeric)::text`,
            })
            .from(invStockLevels)
            .where(eq(invStockLevels.orgId, orgId))
            .groupBy(invStockLevels.productVariantId),
        ]);

        // C1. Ledger quantities stay as the exact `numeric(18,4)` strings
        // Postgres returned. `parseFloat` on these was the bug: the comparison
        // two lines below decides whether an organisation buys stock, and a
        // float comparison of a position against its minimum is wrong exactly
        // when the position sits on it.
        const stockMap = new Map<string, { onHand: string; onOrder: string; outgoing: string }>();
        for (const s of stockRows) {
          stockMap.set(String(s.variantId), {
            onHand: s.onHand,
            onOrder: s.onOrder,
            outgoing: s.outgoing,
          });
        }

        const today = new Date();
        const allSuggestions = rules
          .map((rule) => {
            const stock = stockMap.get(String(rule.productVariantId));
            const onHand = stock?.onHand ?? "0";
            const incoming = stock?.onOrder ?? "0";
            const outgoing = stock?.outgoing ?? "0";
            const forecasted = subDec(addDec(onHand, incoming), outgoing);
            const minQty = rule.minQty;
            if (cmpDec(forecasted, minQty) >= 0) return null;

            const maxQty = rule.maxQty ?? null;
            const reorderQty = rule.reorderQty ?? null;
            const qty =
              maxQty !== null
                ? atLeastZero(subDec(maxQty, forecasted))
                : (reorderQty ?? subDec(minQty, forecasted));
            const vendorId = rule.vendorId ?? rule.productVariant.product.defaultVendorId ?? null;

            const expectedDate = new Date(today);
            expectedDate.setDate(expectedDate.getDate() + (rule.leadTimeDays ?? 7));

            return {
              productVariantId: rule.productVariantId,
              variantSku: rule.productVariant.sku,
              variantName: rule.productVariant.name,
              productName: rule.productVariant.product.name,
              ruleId: rule.id,
              warehouseId: rule.warehouseId ?? null,
              warehouseName: rule.warehouse?.name ?? null,
              // The arithmetic above is exact; these three fields cross to a
              // JSON number once, at the wire, because the client sums them for
              // display and has no decimal helper of its own yet. Nothing is
              // decided on the float.
              currentOnHand: fromExact(onHand),
              forecasted: fromExact(forecasted),
              suggestedQty: fromExact(qty),
              vendorId,
              leadTimeDays: rule.leadTimeDays ?? 7,
              expectedDate: expectedDate.toISOString().slice(0, 10),
              reason: `Forecasted qty (${forecasted}) below min (${minQty})`,
            };
          })
          .filter((s): s is NonNullable<typeof s> => s !== null);

        const total = allSuggestions.length;
        const offset = (page - 1) * limit;
        const items = allSuggestions.slice(offset, offset + limit);

        return { items, total, page, totalPages: Math.ceil(total / limit) };
      },
      CACHE_TTL.SHORT,
    );
  }

export async function getSuggestionForVariant(
  db: Db,
  orgId: string,
  variantId: number,
  warehouseId?: number,
) {
    const ruleWhere = warehouseId != null
      ? and(
          eq(invReorderRules.orgId, orgId),
          eq(invReorderRules.isActive, true),
          eq(invReorderRules.productVariantId, variantId),
          eq(invReorderRules.warehouseId, warehouseId),
        )
      : and(
          eq(invReorderRules.orgId, orgId),
          eq(invReorderRules.isActive, true),
          eq(invReorderRules.productVariantId, variantId),
        );

    const [rules, stockRows] = await Promise.all([
      db.query.invReorderRules.findMany({
        where: ruleWhere,
        with: {
          productVariant: { with: { product: { columns: { id: true, name: true, sku: true, defaultVendorId: true } } } },
          warehouse: { columns: { id: true, name: true } },
        },
        limit: 10,
      }),
      db
        .select({
          variantId: invStockLevels.productVariantId,
          onHand: sql<string>`SUM(${invStockLevels.onHand}::numeric)::text`,
          onOrder: sql<string>`SUM(${invStockLevels.onOrder}::numeric)::text`,
          outgoing: sql<string>`SUM(${invStockLevels.outgoingQty}::numeric)::text`,
        })
        .from(invStockLevels)
        .where(and(eq(invStockLevels.orgId, orgId), eq(invStockLevels.productVariantId, variantId)))
        .groupBy(invStockLevels.productVariantId),
    ]);

    const stockRow = stockRows[0];
    const onHand = stockRow?.onHand ?? "0";
    const incoming = stockRow?.onOrder ?? "0";
    const outgoing = stockRow?.outgoing ?? "0";
    const today = new Date();

    for (const rule of rules) {
      const forecasted = subDec(addDec(onHand, incoming), outgoing);
      const minQty = rule.minQty;
      if (cmpDec(forecasted, minQty) >= 0) continue;

      const maxQty = rule.maxQty ?? null;
      const reorderQty = rule.reorderQty ?? null;
      const qty =
        maxQty !== null
          ? atLeastZero(subDec(maxQty, forecasted))
          : (reorderQty ?? subDec(minQty, forecasted));
      const vendorId = rule.vendorId ?? rule.productVariant.product.defaultVendorId ?? null;
      const expectedDate = new Date(today);
      expectedDate.setDate(expectedDate.getDate() + (rule.leadTimeDays ?? 7));

      return {
        productVariantId: rule.productVariantId,
        variantSku: rule.productVariant.sku,
        variantName: rule.productVariant.name,
        productName: rule.productVariant.product.name,
        ruleId: rule.id,
        warehouseId: rule.warehouseId ?? null,
        warehouseName: rule.warehouse?.name ?? null,
        currentOnHand: fromExact(onHand),
        forecasted: fromExact(forecasted),
        suggestedQty: fromExact(qty),
        /** The exact figure, for callers that go on to order against it. */
        suggestedQtyExact: qty,
        vendorId,
        leadTimeDays: rule.leadTimeDays ?? 7,
        expectedDate: expectedDate.toISOString().slice(0, 10),
        reason: `Forecasted qty (${forecasted}) below min (${minQty})`,
      };
    }

    return null;
  }
