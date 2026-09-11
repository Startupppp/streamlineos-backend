import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { MovementsQueryInput, StockSummaryQueryInput, ReorderQueryInput } from "./dto/inv-reports.schemas";
import {
  invStockLevels,
  invStockTransactions,
  invProducts,
  invProductVariants,
  invPurchaseOrders,
  invSalesOrders,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { buildCursorPage, decodeTimestampCursor } from "../../../common/pagination/cursor";
import { keysetBeforeMicros, microsecondCursorValue } from "../../../common/pagination/keyset";
import { InvReportsExtendedService } from "./inv-reports-extended.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { availableQtySql } from "../stock-engine/available-sql";

@Injectable()
export class InvReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly extended: InvReportsExtendedService,
  ) {}

  async getDashboard(orgId: string, userId: string) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const scopeKey = scope === null ? "all" : ([...scope].sort((a, b) => a - b).join(".") || "none");
    const stockScope = this.warehouseScope.locationPredicate(scope, sql`${invStockLevels.locationId}`);
    return this.cache.cachedVersioned(
      CACHE_KEYS.invDashboardNamespace(orgId),
      scopeKey,
      async () => {
        const [stockSummary, lowStockRows, draftPoRows, openSoRows] = await Promise.all([
          this.db
            .select({
              totalSkus: sql<number>`count(distinct ${invStockLevels.productVariantId})::int`,
              totalOnHand: sql<number>`COALESCE(sum(${invStockLevels.onHand}::numeric), 0)::float`,
              totalCommitted: sql<number>`COALESCE(sum(${invStockLevels.committed}::numeric), 0)::float`,
              totalOnOrder: sql<number>`COALESCE(sum(${invStockLevels.onOrder}::numeric), 0)::float`,
            })
            .from(invStockLevels)
            .where(and(eq(invStockLevels.orgId, orgId), stockScope)),

          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invStockLevels)
            .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
            .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
            .where(
              and(
                eq(invStockLevels.orgId, orgId),
                stockScope,
                sql`${invStockLevels.onHand}::numeric <= ${invProducts.reorderPoint}::numeric`,
              ),
            ),

          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invPurchaseOrders)
            .where(and(eq(invPurchaseOrders.orgId, orgId), eq(invPurchaseOrders.status, "DRAFT"))),

          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invSalesOrders)
            .where(and(eq(invSalesOrders.orgId, orgId), eq(invSalesOrders.status, "CONFIRMED"))),
        ]);

        const recentMovements = await this.db.query.invStockTransactions.findMany({
          where: eq(invStockTransactions.orgId, orgId),
          orderBy: [desc(invStockTransactions.createdAt)],
          limit: 10,
          with: {
            productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
            location: { columns: { id: true, name: true } },
            creator: { columns: { id: true, name: true } },
          },
        });

        const extras = await this.extended.getDashboardExtras(orgId, userId);

        return {
          stockSummary: stockSummary[0],
          lowStockCount: lowStockRows[0]?.count ?? 0,
          draftPoCount: draftPoRows[0]?.count ?? 0,
          openSoCount: openSoRows[0]?.count ?? 0,
          recentMovements,
          ...extras,
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  async getStockSummary(orgId: string, userId: string, filters: StockSummaryQueryInput) {
    const { page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const scopeKey = scope === null ? "all" : ([...scope].sort((a, b) => a - b).join(".") || "none");
    const stockScope = this.warehouseScope.locationPredicate(scope, sql`${invStockLevels.locationId}`);
    return this.cache.cachedVersioned(
      CACHE_KEYS.invStockSummaryReportNamespace(orgId),
      `${scopeKey}:${page}:${limit}`,
      async () => {
        const [items, countResult] = await Promise.all([
          this.db.query.invStockLevels.findMany({
            where: and(eq(invStockLevels.orgId, orgId), stockScope),
            columns: {
              id: true,
              orgId: true,
              productVariantId: true,
              locationId: true,
              onHand: true,
              committed: true,
              onOrder: true,
              blockedQty: true,
              qualityHoldQty: true,
              averageCost: true,
              updatedAt: true,
            },
            with: {
              productVariant: {
                with: {
                  product: {
                    columns: { id: true, name: true, sku: true, costPrice: true, reorderPoint: true },
                  },
                },
              },
              location: { with: { warehouse: { columns: { id: true, name: true } } } },
            },
            orderBy: [desc(invStockLevels.updatedAt)],
            limit,
            offset,
          }),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invStockLevels)
            .where(and(eq(invStockLevels.orgId, orgId), stockScope)),
        ]);

        const total = countResult[0]?.count ?? 0;
        const availability = await this.availabilityByLevelId(
          orgId,
          items.map((item) => item.id),
        );

        return {
          // A1. The stock-summary screen used to compute its "Available" column
          // as `onHand - committed`: two terms of five, and no transit gate. The
          // row it maps from does not even carry the other three, so the number
          // could not be corrected there — it has to be computed here, by the
          // one definition, and read verbatim by the client.
          items: items.map((item) => ({
            ...item,
            // The ids came out of this same table under this same tenant filter
            // a statement ago, so the lookup always hits; the fallback exists
            // only because a Map says it might not.
            availableQty: availability.get(item.id) ?? "0.0000",
          })),
          total,
          page,
          totalPages: Math.ceil(total / limit),
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  /**
   * Availability for one page of stock levels, keyed by level id.
   *
   * A second statement rather than an expression on the relational query above:
   * the relational query builder aliases its root table by its TypeScript name
   * (`invStockLevels`), so an `extras` expression would have to hard-code that
   * quoted alias and would break silently the day the schema key is renamed.
   * The ids are the page's own primary keys, so this is one indexed lookup of
   * at most `limit` rows, not an N+1.
   */
  private async availabilityByLevelId(
    orgId: string,
    levelIds: number[],
  ): Promise<Map<number, string>> {
    if (levelIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        id: invStockLevels.id,
        availableQty: sql<string>`${availableQtySql("inv_stock_levels")}::text`,
      })
      .from(invStockLevels)
      .where(and(eq(invStockLevels.orgId, orgId), inArray(invStockLevels.id, levelIds)));
    return new Map(rows.map((row) => [row.id, row.availableQty]));
  }

  /**
   * The scope discriminator in the cache key is not decoration.
   *
   * Narrowing the query below while leaving the key as `<page>:<limit>` would
   * make this WORSE than the unscoped report it replaces: the first caller's
   * narrowed answer would be stored under a scope-free key and served to the
   * next, so a picker's page would be handed to the buyer and the buyer's whole
   * organisation back to the picker — the filter defeated in both directions
   * (§6). `scopeKey` rather than a hand-rolled join, so it cannot come out
   * subtly different from the one the predicate was built from.
   */
  getReorderReport(orgId: string, userId: string, filters: ReorderQueryInput) {
    return this.warehouseScope.resolve(orgId, userId).then((scope) =>
      this.cache.cachedVersioned(
        CACHE_KEYS.invReorderNamespace(orgId),
        `${this.warehouseScope.scopeKey(scope)}:${filters.page}:${filters.limit}`,
        () => this.extended.getReorderReportUpgraded(orgId, userId, filters),
        CACHE_TTL.MEDIUM,
      ),
    );
  }

  /**
   * G1. The same ledger and the same `(created_at, id)` cursor as
   * `InvStockService.listTransactions` — the reasoning is written out there.
   * Offset stays for callers that only know `page`; a `cursor` supersedes it.
   */
  async getMovementsReport(orgId: string, userId: string, query: MovementsQueryInput) {
    const { fromDate, toDate, warehouseId, transactionType, page, limit, cursor } = query;
    const position = decodeTimestampCursor(cursor);
    const offset = (page - 1) * limit;
    const conditions = [eq(invStockTransactions.orgId, orgId)];
    conditions.push(
      this.warehouseScope.locationPredicate(
        await this.warehouseScope.resolve(orgId, userId),
        sql`${invStockTransactions.locationId}`,
      ),
    );
    if (fromDate) {
      conditions.push(gte(invStockTransactions.createdAt, new Date(fromDate)));
    }
    if (toDate) {
      conditions.push(lte(invStockTransactions.createdAt, new Date(toDate)));
    }
    if (transactionType) {
      conditions.push(eq(invStockTransactions.transactionType, transactionType));
    }
    if (warehouseId) {
      conditions.push(
        sql`${invStockTransactions.locationId} IN (SELECT id FROM inv_locations WHERE warehouse_id = ${warehouseId} AND org_id = ${orgId})`,
      );
    }
    const where = and(...conditions);

    const rowsPromise = this.db.query.invStockTransactions.findMany({
      where: position
        ? and(where, keysetBeforeMicros(invStockTransactions.createdAt, invStockTransactions.id, position))
        : where,
      orderBy: [desc(invStockTransactions.createdAt), desc(invStockTransactions.id)],
      limit: limit + 1,
      offset: position ? 0 : offset,
      extras: {
        cursorAt: microsecondCursorValue(invStockTransactions.createdAt).as("cursor_at"),
      },
      with: {
        productVariant: {
          with: { product: { columns: { id: true, name: true, sku: true } } },
        },
        location: {
          columns: { id: true, name: true, code: true },
          with: { warehouse: { columns: { id: true, name: true } } },
        },
        creator: { columns: { id: true, name: true } },
      },
    });
    const totalPromise: Promise<number | null> = position
      ? Promise.resolve(null)
      : this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(invStockTransactions)
          .where(where)
          .then((rows) => rows[0]?.count ?? 0);
    const [rows, total] = await Promise.all([rowsPromise, totalPromise]);

    const cursorPage = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.cursorAt,
      id: String(row.id),
    }));

    return {
      items: cursorPage.data.map(({ cursorAt: _cursorAt, ...row }) => row),
      total,
      page,
      totalPages: total === null ? null : Math.ceil(total / limit),
      ...cursorPage.pagination,
    };
  }
}
