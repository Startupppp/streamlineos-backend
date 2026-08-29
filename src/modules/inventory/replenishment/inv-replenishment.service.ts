import { ConflictException, Inject, Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
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
import { applyOrderPolicy } from "./forecast/order-policy";
import { runIdempotent } from "../stock-engine/idempotency";
import { ReorderProposalService } from "./forecast/reorder-proposal.service";
import { addDec, cmpDec, mulDec, subDec } from "../stock-engine/decimal";
import { atLeastZero, fromExact, isPositiveExact, toExact } from "./forecast/exact";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A replayed draft PO, rebuilt from the stored JSON. */
function revivePo(stored: unknown): { id: number; poNumber: string } {
  const row = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  return { id: Number(row.id ?? 0), poNumber: String(row.poNumber ?? "") };
}

@Injectable()
export class InvReplenishmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly reorderProposals: ReorderProposalService,
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

  /**
   * C2/INV-309. The client names *which* variants to order, never *how many*.
   *
   * The quantity used to be taken straight from the request body, so a modified
   * payload produced a purchase order for any amount the caller liked — and
   * nothing applied the supplier's minimum order quantity or pack size, so the
   * numbers the vendor received were frequently ones they would reject.
   *
   * Every line is now re-derived here: the suggestion engine's quantity for
   * that variant, put through the supplier's order policy. A body quantity is
   * ignored rather than rejected, because the caller is not doing anything
   * wrong by sending one — it is simply not the authority.
   */
  /**
   * A3. Creating a draft purchase order took no key, so a double-clicked
   * "Create Draft PO" raised two orders for the same shortfall — and because
   * the quantity is re-derived from the live suggestion, the second one looked
   * perfectly legitimate.
   */
  async generatePo(orgId: string, userId: string, body: GeneratePoInput, idempotencyKey: string) {
    const recomputed = await Promise.all(
      body.suggestions.map(async (s) => {
        const suggestion = await this.getSuggestionForVariant(
          orgId,
          s.productVariantId,
          body.warehouseId ?? undefined,
        );
        const [policy] = await this.db
          .select({
            minOrderQty: invProducts.minOrderQty,
            orderMultiple: invProducts.orderMultiple,
          })
          .from(invProductVariants)
          .innerJoin(
            invProducts,
            and(
              eq(invProducts.orgId, invProductVariants.orgId),
              eq(invProducts.id, invProductVariants.productId),
            ),
          )
          .where(
            and(
              eq(invProductVariants.orgId, orgId),
              eq(invProductVariants.id, s.productVariantId),
            ),
          );

        // C2 item 4. The forecast engine is the default brain; a min/max rule is
        // a policy override, not the source of truth.
        //
        // `getSuggestionForVariant` reads `inv_reorder_rules` — a static
        // min/max per (variant, warehouse) that knows nothing about demand,
        // lead time or variability. The proposal service does, and states its
        // evidence and its caveats. So the proposal wins where it will commit to
        // a number, and the rule answers only where it will not: a variant with
        // gappy demand, no demand, or too little history, where a forecast would
        // be a guess dressed as arithmetic.
        //
        // C1 closed the gap this comment used to record: the proposal service
        // is warehouse-scoped now, so a purchase order raised for one site is
        // sized against that site's demand, position and supplier lead time
        // rather than against the organisation's average of every site.
        const proposal = await this.reorderProposals.propose(orgId, s.productVariantId, {
          warehouseId: body.warehouseId ?? null,
        });

        // `hold` means two different things and collapsing them is a regression
        // that looks like the engine working. A **null** reorder point says the
        // model could not describe this demand at all — no history, or a shape
        // it does not fit — and that is the one case a static rule legitimately
        // answers. A **numeric** reorder point with a hold says the engine
        // looked and the position is already covered; buying against that
        // because a rule says so is precisely what this unit removes.
        const engineModelled = proposal.reorderPoint !== null;
        // Exact throughout: this is the quantity that becomes a line on a
        // purchase order somebody signs.
        const engineQty = engineModelled
          ? proposal.suggestedQuantity ?? "0"
          : suggestion?.suggestedQtyExact ?? "0";

        const decidedBy = engineModelled ? "forecast" : "min/max policy override";
        // `min_order_qty` and `order_multiple` are `numeric` columns; drizzle
        // hands them back as exact strings and they stay that way.
        const rounded = applyOrderPolicy(engineQty, {
          minOrderQty: policy?.minOrderQty ?? null,
          orderMultiple: policy?.orderMultiple ?? null,
        });

        return {
          productVariantId: s.productVariantId,
          suggestedQty: rounded.ordered,
          unitCost: toExact(s.unitCost ?? 0),
          // Said out loud on the line, so a buyer reading the order can tell a
          // forecast from a static rule without re-deriving either.
          policyReasons: [
            ...rounded.reasons,
            ...(isPositiveExact(engineQty) ? [`Quantity decided by the ${decidedBy}.`] : []),
            ...proposal.caveats,
          ],
        };
      }),
    );

    const orderable = recomputed.filter((line) => isPositiveExact(line.suggestedQty));
    if (orderable.length === 0) {
      throw new BadRequestException(
        "None of these variants still need ordering — the shortfall has already been met.",
      );
    }

    return this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.replenishment.generate-po", orderable },
        () => this.createDraftPoInTx(tx, orgId, userId, body, orderable),
        (stored) => revivePo(stored),
      ),
    );
  }

  private async createDraftPoInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    body: GeneratePoInput,
    orderable: ReadonlyArray<{
      productVariantId: number;
      /** Exact decimal string — this becomes `inv_po_lines.quantity`. */
      suggestedQty: string;
      /** Exact decimal string — this becomes `inv_po_lines.unit_cost`. */
      unitCost: string;
      policyReasons: string[];
    }>,
  ) {
    const poNumber = await this.numSeq.next(orgId, "PO", tx);
    const today = new Date().toISOString().slice(0, 10);

    // Money, and it is written to a column. A float subtotal over a dozen lines
    // is off by a fraction of a paisa, which is exactly the sort of difference
    // that makes a purchase order and its receipt fail to reconcile.
    const subtotal = orderable.reduce(
      (sum, s) => addDec(sum, mulDec(s.suggestedQty, s.unitCost)),
      "0",
    );

    const [po] = await tx
      .insert(invPurchaseOrders)
      .values({
        orgId,
        vendorId: body.vendorId,
        poNumber,
        status: "DRAFT",
        orderDate: today,
        warehouseId: body.warehouseId,
        subtotal,
        taxAmount: "0",
        discount: "0",
        total: subtotal,
        currency: "INR",
        createdBy: userId,
      })
      .returning();

    await tx.insert(invPoLines).values(
      orderable.map((s, i) => ({
        orgId,
        poId: po.id,
        productVariantId: s.productVariantId,
        quantity: s.suggestedQty,
        quantityReceived: "0",
        unitCost: s.unitCost,
        taxRate: "0",
        amount: mulDec(s.suggestedQty, s.unitCost),
        lineOrder: i,
      })),
    );

    return po;
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
      // A weekly demand figure feeding an average: a statistic, so it crosses
      // into a float here, once, by the named boundary.
      list.push(fromExact(s.weeklyQty));
      salesByVariant.set(s.variantId, list);
    }

    const items = stockRows.map((row) => {
      const weeklySales = salesByVariant.get(row.variantId) ?? [];
      const avgWeeklyDemand =
        weeklySales.length > 0 ? weeklySales.reduce((a, b) => a + b, 0) / weeklySales.length : 0;
      // Exact ledger quantities. `available` here is deliberately the *future*
      // position — on hand plus on order — and not availability-to-promise;
      // `availableQtySql` answers the other question.
      const onHand = row.onHand;
      const onOrder = row.onOrder;
      const position = addDec(onHand, onOrder);
      const positionValue = fromExact(position);
      // Projections are estimates, not quantities anybody owns, so they stay in
      // floating point and are labelled as projections.
      const projectedWeeks = [1, 2, 3, 4].map((w) => ({
        week: w,
        projectedDemand: Math.round(avgWeeklyDemand * w * 100) / 100,
        projectedStock:
          Math.round(Math.max(0, positionValue - avgWeeklyDemand * w) * 100) / 100,
      }));
      const weeksOfStock = avgWeeklyDemand > 0 ? positionValue / avgWeeklyDemand : null;
      const stockoutRisk = weeksOfStock != null ? (weeksOfStock < 2 ? "HIGH" : weeksOfStock < 4 ? "MEDIUM" : "LOW") : "NONE";

      return {
        variantId: row.variantId,
        variantSku: row.variantSku,
        variantName: row.variantName,
        productName: row.productName,
        onHand,
        onOrder,
        avgWeeklyDemand: Math.round(avgWeeklyDemand * 100) / 100,
        weeksOfStock: weeksOfStock != null ? Math.round(weeksOfStock * 100) / 100 : null,
        stockoutRisk,
        projectedWeeks,
      };
    });

    return { items, total: countRow?.total ?? 0, page, totalPages: Math.ceil((countRow?.total ?? 0) / limit) };
  }
}
