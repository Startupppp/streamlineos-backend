import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  invValuationLayers,
  invStockLevels,
  invProductVariants,
  invProducts,
  invLocations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import type { ValuationSummaryInput, ValuationLayersInput } from "./dto/valuation.schemas";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";

@Injectable()
export class InvValuationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async getValuationSummary(orgId: string, userId: string, filters: ValuationSummaryInput) {
    const { warehouseId, page, limit } = filters;
    const offset = (page - 1) * limit;

    const scope = await this.warehouseScope.resolve(orgId, userId);
    const stockConditions = [eq(invStockLevels.orgId, orgId)];
    stockConditions.push(this.warehouseScope.warehousePredicate(scope, sql`${invLocations.warehouseId}`));
    // The FIFO subquery sums layers for the variant, and layers are keyed per
    // location since 0400 — so it needs the same scope or the value would
    // include warehouses the caller cannot see.
    const layerScope = this.warehouseScope.locationPredicate(scope, sql.raw("vl.location_id"));
    const locCondition = warehouseId != null ? eq(invLocations.warehouseId, warehouseId) : undefined;

    const baseQuery = this.db
      .select({
        productVariantId: invStockLevels.productVariantId,
        variantSku: invProductVariants.sku,
        variantName: invProductVariants.name,
        productId: invProducts.id,
        productName: invProducts.name,
        costingMethod: invProducts.costingMethod,
        standardCost: invProducts.standardCost,
        onHand: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric), 0)::text`,
        avgCost: sql<string>`COALESCE(AVG(NULLIF(${invStockLevels.averageCost}::numeric, 0)), 0)::text`,
        fifoValue: sql<string>`COALESCE((
          SELECT SUM(vl.remaining_value::numeric)
          FROM inv_valuation_layers vl
          WHERE vl.org_id = ${orgId}
            AND vl.product_variant_id = ${invStockLevels.productVariantId}
            AND vl.remaining_quantity::numeric > 0
            AND ${layerScope}
        ), 0)::text`,
      })
      .from(invStockLevels)
      .innerJoin(invLocations, eq(invStockLevels.locationId, invLocations.id))
      .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
      .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
      .where(locCondition != null ? and(...stockConditions, locCondition) : and(...stockConditions))
      .groupBy(invStockLevels.productVariantId, invProductVariants.id, invProducts.id)
      .orderBy(invProductVariants.sku)
      .limit(limit)
      .offset(offset);

    const countQuery = this.db
      .select({ total: sql<number>`count(distinct ${invStockLevels.productVariantId})::int` })
      .from(invStockLevels)
      .innerJoin(invLocations, eq(invStockLevels.locationId, invLocations.id))
      .where(locCondition != null ? and(...stockConditions, locCondition) : and(...stockConditions));

    const [rows, [countRow]] = await Promise.all([baseQuery, countQuery]);

    const items = rows.map((r) => {
      const onHand = parseFloat(r.onHand);
      let value: number;
      if (r.costingMethod === "FIFO") {
        value = parseFloat(r.fifoValue);
      } else if (r.costingMethod === "STANDARD") {
        value = onHand * parseFloat(r.standardCost ?? "0");
      } else {
        value = onHand * parseFloat(r.avgCost);
      }
      return {
        productVariantId: r.productVariantId,
        variantSku: r.variantSku,
        variantName: r.variantName,
        productId: r.productId,
        productName: r.productName,
        costingMethod: r.costingMethod,
        onHand,
        value: Math.round(value * 10000) / 10000,
        averageCost: parseFloat(r.avgCost),
      };
    });

    const totalValue = items.reduce((sum, i) => sum + i.value, 0);
    const total = countRow?.total ?? 0;

    return {
      items,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      totalValue: Math.round(totalValue * 10000) / 10000,
    };
  }

  async getValuationLayers(orgId: string, userId: string, filters: ValuationLayersInput) {
    const { variantId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const where = and(
      eq(invValuationLayers.orgId, orgId),
      eq(invValuationLayers.productVariantId, variantId),
      this.warehouseScope.locationPredicate(scope, sql`${invValuationLayers.locationId}`),
    );

    const [items, [countRow]] = await Promise.all([
      this.db.query.invValuationLayers.findMany({
        where,
        orderBy: [desc(invValuationLayers.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ total: sql<number>`count(*)::int` }).from(invValuationLayers).where(where),
    ]);

    return { items, total: countRow?.total ?? 0, page, totalPages: Math.ceil((countRow?.total ?? 0) / limit) };
  }
}
