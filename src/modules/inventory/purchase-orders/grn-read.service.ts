import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { invPurchaseOrders, invGrns } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import type { ListGrnInput } from "./dto/inv-purchase-orders.schemas";

/**
 * B1 — reading receipts.
 *
 * Split from the lifecycle service because the two obey different rules: a read
 * is cached under a key that must carry the caller's warehouse scope and every
 * filter, and a write invalidates that namespace. Keeping them in one file is
 * how a service grows past the point where either half can be reviewed.
 */
@Injectable()
export class GrnReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async listGrns(orgId: string, userId: string, filters: ListGrnInput) {
    const { poId, vendorId, status, dateFrom, dateTo, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${poId ?? ""}:${vendorId ?? ""}:${status ?? ""}:${dateFrom ?? ""}:${dateTo ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(
      CACHE_KEYS.invGrnNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invGrns.orgId, orgId), scope.location(sql`${invGrns.locationId}`)];
        if (poId) conditions.push(eq(invGrns.poId, poId));
        if (status) conditions.push(eq(invGrns.status, status));
        if (dateFrom) conditions.push(gte(invGrns.receivedDate, dateFrom));
        if (dateTo) conditions.push(lte(invGrns.receivedDate, dateTo));

        if (vendorId) {
          const poIds = await this.db
            .select({ id: invPurchaseOrders.id })
            .from(invPurchaseOrders)
            .where(
              and(
                eq(invPurchaseOrders.orgId, orgId),
                eq(invPurchaseOrders.vendorId, vendorId),
              ),
            );
          if (poIds.length === 0)
            return { items: [], total: 0, page, totalPages: 0 };
          conditions.push(inArray(invGrns.poId, poIds.map((p) => p.id)));
        }

        const where = and(...conditions);

        const [items, countResult] = await Promise.all([
          this.db.query.invGrns.findMany({
            where,
            orderBy: [desc(invGrns.createdAt)],
            limit,
            offset,
            with: {
              purchaseOrder: {
                columns: { id: true, poNumber: true, vendorId: true },
                with: { vendor: { columns: { id: true, name: true } } },
              },
              creator: { columns: { id: true, name: true } },
            },
          }),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invGrns)
            .where(where),
        ]);

        return {
          items,
          total: countResult[0]?.count ?? 0,
          page,
          totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  /**
   * One receipt, with everything the workbench renders. Warehouse scope is
   * re-asserted here and not only on the list: a clerk assigned to one warehouse
   * could otherwise read every delivery in the organisation by walking ids. Out
   * of scope answers 404, never 403, so this is not an existence oracle.
   */
  async getGrn(orgId: string, grnId: number, userId: string) {
    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      with: {
        lines: { with: { serials: { columns: { id: true, serialNumber: true } } } },
        purchaseOrder: {
          columns: { id: true, poNumber: true, vendorId: true, status: true },
          with: { vendor: { columns: { id: true, name: true } } },
        },
        creator: { columns: { id: true, name: true } },
        poster: { columns: { id: true, name: true } },
      },
    });
    if (!grn) throw new NotFoundException("GRN not found");
    await this.warehouseScope.assertLocationVisible(orgId, userId, grn.locationId);
    return grn;
  }
}
