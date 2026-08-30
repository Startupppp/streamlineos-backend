import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  invPurchaseOrders,
  invPoLines,
  invGrns,
  invStockTransactions,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import type {
  ListGrnInput,
  ReverseGrnInput,
} from "./dto/inv-purchase-orders.schemas";

@Injectable()
export class GrnService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
  ) {}

  async listGrns(orgId: string, filters: ListGrnInput) {
    const { poId, vendorId, dateFrom, dateTo, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${poId ?? ""}:${vendorId ?? ""}:${dateFrom ?? ""}:${dateTo ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(
      CACHE_KEYS.invGrnNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invGrns.orgId, orgId)];
        if (poId) conditions.push(eq(invGrns.poId, poId));
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
          conditions.push(
            inArray(
              invGrns.poId,
              poIds.map((p) => p.id),
            ),
          );
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

  async getGrn(orgId: string, grnId: number) {
    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      with: {
        lines: true,
        purchaseOrder: {
          columns: { id: true, poNumber: true, vendorId: true },
          with: { vendor: { columns: { id: true, name: true } } },
        },
        creator: { columns: { id: true, name: true } },
      },
    });
    if (!grn) throw new NotFoundException("GRN not found");
    return grn;
  }

  async reverseGrn(
    orgId: string,
    grnId: number,
    userId: string,
    idempotencyKey: string,
    data: ReverseGrnInput,
  ) {
    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      with: { lines: true },
    });
    if (!grn) throw new NotFoundException("GRN not found");

    const txns = await this.db.query.invStockTransactions.findMany({
      where: and(
        eq(invStockTransactions.orgId, orgId),
        eq(invStockTransactions.referenceType, "inv_grn"),
        eq(invStockTransactions.referenceId, String(grnId)),
      ),
    });

    if (txns.length === 0)
      throw new BadRequestException("No stock transactions found for this GRN");

    await this.db.transaction(async (tx) => {
      for (let i = 0; i < txns.length; i++) {
        const txn = txns[i]!;
        const reverseKey = `${idempotencyKey}:rev:${txn.id}`;
        await this.engine.reverseInTx(tx, orgId, userId, {
          idempotencyKey: reverseKey,
          stockTransactionId: txn.id,
          reason: data.reason,
        });
      }

      const po = await tx.query.invPurchaseOrders.findFirst({
        where: and(
          eq(invPurchaseOrders.id, grn.poId),
          eq(invPurchaseOrders.orgId, orgId),
        ),
        with: { lines: true },
      });

      if (po) {
        for (const grnLine of grn.lines) {
          await tx
            .update(invPoLines)
            .set({
              quantityReceived: sql`GREATEST(0, ${invPoLines.quantityReceived} - ${grnLine.quantityReceived})`,
            })
            .where(
              and(
                eq(invPoLines.id, grnLine.poLineId),
                eq(invPoLines.poId, po.id),
              ),
            );
        }

        const updatedLines = await tx.query.invPoLines.findMany({
          where: eq(invPoLines.poId, po.id),
        });
        const anyReceived = updatedLines.some(
          (l) => parseFloat(l.quantityReceived) > 0,
        );
        const newStatus = anyReceived ? "PARTIAL" : "SENT";

        await tx
          .update(invPurchaseOrders)
          .set({ status: newStatus, updatedAt: new Date() })
          .where(
            and(
              eq(invPurchaseOrders.id, po.id),
              eq(invPurchaseOrders.orgId, orgId),
            ),
          );
      }

    });

    await this.engine.invalidateCaches(orgId);

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, grn.poId));
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.invGrnNamespace(orgId)),
    ]);

    return { reversed: true, grnId, transactionCount: txns.length };
  }
}
