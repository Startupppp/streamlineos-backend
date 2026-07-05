import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { MovementsQueryInput } from "./dto/inv-reports.schemas";
import {
  invStockLevels,
  invStockTransactions,
  invProducts,
  invProductVariants,
  invPurchaseOrders,
  invSalesOrders,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { InvReportsExtendedService } from "./inv-reports-extended.service";

@Injectable()
export class InvReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly extended: InvReportsExtendedService,
  ) {}

  async getDashboard(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.invDashboard(orgId),
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
            .where(eq(invStockLevels.orgId, orgId)),

          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invStockLevels)
            .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
            .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
            .where(
              and(
                eq(invStockLevels.orgId, orgId),
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

        const extras = await this.extended.getDashboardExtras(orgId);

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

  getStockSummary(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.invStockSummary(orgId),
      () =>
        this.db.query.invStockLevels.findMany({
          where: eq(invStockLevels.orgId, orgId),
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
        }),
      CACHE_TTL.MEDIUM,
    );
  }

  getReorderReport(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.invReorderReport(orgId),
      () => this.extended.getReorderReportUpgraded(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  async getMovementsReport(orgId: string, query: MovementsQueryInput) {
    const { fromDate, toDate, page, limit } = query;
    const offset = (page - 1) * limit;
    const conditions = [eq(invStockTransactions.orgId, orgId)];
    if (fromDate) {
      conditions.push(gte(invStockTransactions.createdAt, new Date(fromDate)));
    }
    if (toDate) {
      conditions.push(lte(invStockTransactions.createdAt, new Date(toDate)));
    }
    const where = and(...conditions);

    const [items, countResult] = await Promise.all([
      this.db.query.invStockTransactions.findMany({
        where,
        orderBy: [desc(invStockTransactions.createdAt)],
        limit,
        offset,
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
      }),
      this.db.select({ count: sql<number>`count(*)::int` }).from(invStockTransactions).where(where),
    ]);

    return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
  }
}
