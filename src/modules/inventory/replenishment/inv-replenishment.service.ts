import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  invReorderRules,
  invStockLevels,
  invStockTransactions,
  invProductVariants,
  invProducts,
  invPurchaseOrders,
  invPoLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import type { ListRulesInput, CreateRuleInput, UpdateRuleInput, GeneratePoInput, ForecastingInput, SuggestionsQueryInput } from "./dto/replenishment.schemas";

@Injectable()
export class InvReplenishmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
  ) {}

  async listRules(orgId: string, filters: ListRulesInput) {
    const { variantId, warehouseId, active, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions = [eq(invReorderRules.orgId, orgId)];
    if (variantId != null) conditions.push(eq(invReorderRules.productVariantId, variantId));
    if (warehouseId != null) conditions.push(eq(invReorderRules.warehouseId, warehouseId));
    if (active != null) conditions.push(eq(invReorderRules.isActive, active));

    const where = and(...conditions);
    const [items, [countRow]] = await Promise.all([
      this.db.query.invReorderRules.findMany({
        where,
        orderBy: [desc(invReorderRules.updatedAt)],
        limit,
        offset,
        with: {
          productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
          warehouse: { columns: { id: true, name: true } },
        },
      }),
      this.db.select({ total: sql<number>`count(*)::int` }).from(invReorderRules).where(where),
    ]);

    return { items, total: countRow?.total ?? 0, page, totalPages: Math.ceil((countRow?.total ?? 0) / limit) };
  }

  async createRule(orgId: string, body: CreateRuleInput) {
    const existing = await this.db.query.invReorderRules.findFirst({
      where: and(
        eq(invReorderRules.orgId, orgId),
        eq(invReorderRules.productVariantId, body.productVariantId),
        body.warehouseId != null
          ? eq(invReorderRules.warehouseId, body.warehouseId)
          : sql`${invReorderRules.warehouseId} IS NULL`,
      ),
    });
    if (existing) throw new ConflictException("A reorder rule already exists for this variant/warehouse combination");

    const [rule] = await this.db
      .insert(invReorderRules)
      .values({
        orgId,
        productVariantId: body.productVariantId,
        warehouseId: body.warehouseId,
        minQty: String(body.minQty),
        maxQty: body.maxQty != null ? String(body.maxQty) : undefined,
        reorderQty: body.reorderQty != null ? String(body.reorderQty) : undefined,
        vendorId: body.vendorId,
        leadTimeDays: body.leadTimeDays,
        safetyStock: body.safetyStock != null ? String(body.safetyStock) : undefined,
        isActive: true,
      })
      .returning();

    await this.cache.invalidateNamespace(CACHE_KEYS.invReplenishmentSuggestionsNamespace(orgId));
    return rule;
  }

  async updateRule(orgId: string, ruleId: number, body: UpdateRuleInput) {
    const rule = await this.db.query.invReorderRules.findFirst({
      where: and(eq(invReorderRules.id, ruleId), eq(invReorderRules.orgId, orgId)),
    });
    if (!rule) throw new NotFoundException("Reorder rule not found");

    const updates: Partial<typeof invReorderRules.$inferInsert> = { updatedAt: new Date() };
    if (body.minQty != null) updates.minQty = String(body.minQty);
    if (body.maxQty != null) updates.maxQty = String(body.maxQty);
    if (body.reorderQty != null) updates.reorderQty = String(body.reorderQty);
    if (body.safetyStock != null) updates.safetyStock = String(body.safetyStock);
    if (body.vendorId !== undefined) updates.vendorId = body.vendorId ?? undefined;
    if (body.leadTimeDays != null) updates.leadTimeDays = body.leadTimeDays;
    if (body.isActive != null) updates.isActive = body.isActive;

    const [updated] = await this.db
      .update(invReorderRules)
      .set(updates)
      .where(and(eq(invReorderRules.id, ruleId), eq(invReorderRules.orgId, orgId)))
      .returning();

    await this.cache.invalidateNamespace(CACHE_KEYS.invReplenishmentSuggestionsNamespace(orgId));
    return updated;
  }

  async deleteRule(orgId: string, ruleId: number) {
    const rule = await this.db.query.invReorderRules.findFirst({
      where: and(eq(invReorderRules.id, ruleId), eq(invReorderRules.orgId, orgId)),
    });
    if (!rule) throw new NotFoundException("Reorder rule not found");

    const [updated] = await this.db
      .update(invReorderRules)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(invReorderRules.id, ruleId), eq(invReorderRules.orgId, orgId)))
      .returning();

    await this.cache.invalidateNamespace(CACHE_KEYS.invReplenishmentSuggestionsNamespace(orgId));
    return updated;
  }

  async getSuggestions(orgId: string, filters: SuggestionsQueryInput) {
    const { page, limit } = filters;
    return this.cache.cachedVersioned(
      CACHE_KEYS.invReplenishmentSuggestionsNamespace(orgId),
      `${page}:${limit}`,
      async () => {
        const [rules, stockRows] = await Promise.all([
          this.db.query.invReorderRules.findMany({
            where: and(eq(invReorderRules.orgId, orgId), eq(invReorderRules.isActive, true)),
            with: {
              productVariant: { with: { product: { columns: { id: true, name: true, sku: true, defaultVendorId: true } } } },
              warehouse: { columns: { id: true, name: true } },
            },
            limit: 500,
          }),
          this.db
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

        const stockMap = new Map<string, { onHand: number; onOrder: number; outgoing: number }>();
        for (const s of stockRows) {
          stockMap.set(String(s.variantId), {
            onHand: parseFloat(s.onHand),
            onOrder: parseFloat(s.onOrder),
            outgoing: parseFloat(s.outgoing),
          });
        }

        const today = new Date();
        const allSuggestions = rules
          .map((rule) => {
            const stock = stockMap.get(String(rule.productVariantId));
            const onHand = stock?.onHand ?? 0;
            const incoming = stock?.onOrder ?? 0;
            const outgoing = stock?.outgoing ?? 0;
            const forecasted = onHand + incoming - outgoing;
            const minQty = parseFloat(rule.minQty);
            if (forecasted >= minQty) return null;

            const maxQty = rule.maxQty ? parseFloat(rule.maxQty) : null;
            const reorderQty = rule.reorderQty ? parseFloat(rule.reorderQty) : null;
            const qty = maxQty != null ? Math.max(0, maxQty - forecasted) : (reorderQty ?? minQty - forecasted);
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
              currentOnHand: onHand,
              forecasted: Math.round(forecasted * 10000) / 10000,
              suggestedQty: Math.round(qty * 10000) / 10000,
              vendorId,
              leadTimeDays: rule.leadTimeDays ?? 7,
              expectedDate: expectedDate.toISOString().slice(0, 10),
              reason: `Forecasted qty (${Math.round(forecasted * 100) / 100}) below min (${minQty})`,
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

  async getSuggestionForVariant(orgId: string, variantId: number, warehouseId?: number) {
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
      this.db.query.invReorderRules.findMany({
        where: ruleWhere,
        with: {
          productVariant: { with: { product: { columns: { id: true, name: true, sku: true, defaultVendorId: true } } } },
          warehouse: { columns: { id: true, name: true } },
        },
        limit: 10,
      }),
      this.db
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
    const onHand = stockRow ? parseFloat(stockRow.onHand) : 0;
    const incoming = stockRow ? parseFloat(stockRow.onOrder) : 0;
    const outgoing = stockRow ? parseFloat(stockRow.outgoing) : 0;
    const today = new Date();

    for (const rule of rules) {
      const forecasted = onHand + incoming - outgoing;
      const minQty = parseFloat(rule.minQty);
      if (forecasted >= minQty) continue;

      const maxQty = rule.maxQty ? parseFloat(rule.maxQty) : null;
      const reorderQty = rule.reorderQty ? parseFloat(rule.reorderQty) : null;
      const qty = maxQty != null ? Math.max(0, maxQty - forecasted) : (reorderQty ?? minQty - forecasted);
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
        currentOnHand: onHand,
        forecasted: Math.round(forecasted * 10000) / 10000,
        suggestedQty: Math.round(qty * 10000) / 10000,
        vendorId,
        leadTimeDays: rule.leadTimeDays ?? 7,
        expectedDate: expectedDate.toISOString().slice(0, 10),
        reason: `Forecasted qty (${Math.round(forecasted * 100) / 100}) below min (${minQty})`,
      };
    }

    return null;
  }

  async generatePo(orgId: string, userId: string, body: GeneratePoInput) {
    return this.db.transaction(async (tx) => {
      const poNumber = await this.numSeq.next(orgId, "PO", tx);
      const today = new Date().toISOString().slice(0, 10);

      const subtotal = body.suggestions.reduce((sum, s) => {
        const cost = s.unitCost ?? 0;
        return sum + s.suggestedQty * cost;
      }, 0);

      const [po] = await tx
        .insert(invPurchaseOrders)
        .values({
          orgId,
          vendorId: body.vendorId,
          poNumber,
          status: "DRAFT",
          orderDate: today,
          warehouseId: body.warehouseId,
          subtotal: String(subtotal),
          taxAmount: "0",
          discount: "0",
          total: String(subtotal),
          currency: "INR",
          createdBy: userId,
        })
        .returning();

      if (body.suggestions.length > 0) {
        await tx.insert(invPoLines).values(
          body.suggestions.map((s, i) => ({
            orgId,
            poId: po.id,
            productVariantId: s.productVariantId,
            quantity: String(s.suggestedQty),
            quantityReceived: "0",
            unitCost: String(s.unitCost ?? 0),
            taxRate: "0",
            amount: String(s.suggestedQty * (s.unitCost ?? 0)),
            lineOrder: i,
          })),
        );
      }

      return po;
    });
  }

  async getForecasting(orgId: string, filters: ForecastingInput) {
    const { variantId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const stockQuery = this.db
      .select({
        variantId: invStockLevels.productVariantId,
        onHand: sql<string>`SUM(${invStockLevels.onHand}::numeric)::text`,
        onOrder: sql<string>`SUM(${invStockLevels.onOrder}::numeric)::text`,
        variantSku: invProductVariants.sku,
        variantName: invProductVariants.name,
        productName: invProducts.name,
      })
      .from(invStockLevels)
      .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
      .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
      .where(and(eq(invStockLevels.orgId, orgId), variantId != null ? eq(invStockLevels.productVariantId, variantId) : undefined))
      .groupBy(invStockLevels.productVariantId, invProductVariants.id, invProducts.id)
      .limit(limit)
      .offset(offset);

    const salesQuery = this.db
      .select({
        variantId: invStockTransactions.productVariantId,
        weekStart: sql<string>`date_trunc('week', ${invStockTransactions.createdAt})::text`,
        weeklyQty: sql<string>`SUM(ABS(${invStockTransactions.quantityChange}::numeric))::text`,
      })
      .from(invStockTransactions)
      .where(
        and(
          eq(invStockTransactions.orgId, orgId),
          eq(invStockTransactions.transactionType, "SALE"),
          gte(invStockTransactions.createdAt, ninetyDaysAgo),
          variantId != null ? eq(invStockTransactions.productVariantId, variantId) : undefined,
        ),
      )
      .groupBy(invStockTransactions.productVariantId, sql`date_trunc('week', ${invStockTransactions.createdAt})`);

    const [stockRows, salesRows, [countRow]] = await Promise.all([
      stockQuery,
      salesQuery,
      this.db
        .select({ total: sql<number>`count(distinct ${invStockLevels.productVariantId})::int` })
        .from(invStockLevels)
        .where(and(eq(invStockLevels.orgId, orgId), variantId != null ? eq(invStockLevels.productVariantId, variantId) : undefined)),
    ]);

    const salesByVariant = new Map<number, number[]>();
    for (const s of salesRows) {
      const list = salesByVariant.get(s.variantId) ?? [];
      list.push(parseFloat(s.weeklyQty));
      salesByVariant.set(s.variantId, list);
    }

    const items = stockRows.map((row) => {
      const weeklySales = salesByVariant.get(row.variantId) ?? [];
      const avgWeeklyDemand =
        weeklySales.length > 0 ? weeklySales.reduce((a, b) => a + b, 0) / weeklySales.length : 0;
      const onHand = parseFloat(row.onHand);
      const onOrder = parseFloat(row.onOrder);
      const available = onHand + onOrder;
      const projectedWeeks = [1, 2, 3, 4].map((w) => ({
        week: w,
        projectedDemand: Math.round(avgWeeklyDemand * w * 100) / 100,
        projectedStock: Math.round(Math.max(0, available - avgWeeklyDemand * w) * 100) / 100,
      }));
      const weeksOfStock = avgWeeklyDemand > 0 ? available / avgWeeklyDemand : null;
      const stockoutRisk = weeksOfStock != null ? (weeksOfStock < 2 ? "HIGH" : weeksOfStock < 4 ? "MEDIUM" : "LOW") : "NONE";

      return {
        variantId: row.variantId,
        variantSku: row.variantSku,
        variantName: row.variantName,
        productName: row.productName,
        onHand,
        onOrder: parseFloat(row.onOrder),
        avgWeeklyDemand: Math.round(avgWeeklyDemand * 100) / 100,
        weeksOfStock: weeksOfStock != null ? Math.round(weeksOfStock * 100) / 100 : null,
        stockoutRisk,
        projectedWeeks,
      };
    });

    return { items, total: countRow?.total ?? 0, page, totalPages: Math.ceil((countRow?.total ?? 0) / limit) };
  }
}
