import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
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

@Injectable()
export class InvReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getDashboard(orgId: string) {
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

        return {
          stockSummary: stockSummary[0],
          lowStockCount: lowStockRows[0]?.count ?? 0,
          draftPoCount: draftPoRows[0]?.count ?? 0,
          openSoCount: openSoRows[0]?.count ?? 0,
          recentMovements,
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
      () =>
        this.db.query.invStockLevels.findMany({
          where: and(
            eq(invStockLevels.orgId, orgId),
            sql`${invStockLevels.onHand}::numeric <= (
              SELECT reorder_point::numeric
              FROM inv_products p
              JOIN inv_product_variants v ON v.product_id = p.id
              WHERE v.id = ${invStockLevels.productVariantId}
            )`,
          ),
          with: {
            productVariant: {
              with: {
                product: {
                  columns: { id: true, name: true, sku: true, reorderPoint: true, minStockLevel: true },
                },
              },
            },
            location: { with: { warehouse: { columns: { id: true, name: true } } } },
          },
        }),
      CACHE_TTL.MEDIUM,
    );
  }

  getMovementsReport(orgId: string, fromDate?: string, toDate?: string) {
    const conditions = [eq(invStockTransactions.orgId, orgId)];
    if (fromDate) {
      conditions.push(gte(invStockTransactions.createdAt, new Date(fromDate)));
    }
    if (toDate) {
      conditions.push(lte(invStockTransactions.createdAt, new Date(toDate)));
    }

    return this.db.query.invStockTransactions.findMany({
      where: and(...conditions),
      orderBy: [desc(invStockTransactions.createdAt)],
      limit: 500,
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
  }
}
