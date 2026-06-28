import { Inject, Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, lte, sql, gte } from "drizzle-orm";
import {
  invStockLevels, invStockTransactions, invStockAdjustments, invStockAdjustmentLines,
  invStockTransfers, invStockTransferLines,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { ListStockLevelsInput, ListTransactionsInput, ListAdjustmentsInput, CreateAdjustmentInput, CreateTransferInput, CompleteTransferInput, ListTransfersInput } from "./dto/inv-stock.schemas";

function nextRefNumber(prefix: string): string {
  const now = new Date();
  const ts = now.getFullYear().toString() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0") + String(now.getTime()).slice(-6);
  return `${prefix}-${ts}`;
}

@Injectable()
export class InvStockService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async listStockLevels(orgId: string, filters: ListStockLevelsInput) {
    const { warehouseId, productId, lowStock, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${warehouseId ?? ""}:${productId ?? ""}:${lowStock ?? ""}:${limit}:${offset}`;

    return this.cache.cached(CACHE_KEYS.invStockLevels(orgId, hash), async () => {
      const rows = await this.db.query.invStockLevels.findMany({
        where: and(
          eq(invStockLevels.orgId, orgId),
          lowStock
            ? lte(invStockLevels.onHand, sql`(SELECT reorder_point FROM inv_products p JOIN inv_product_variants v ON v.product_id = p.id WHERE v.id = ${invStockLevels.productVariantId})`)
            : undefined,
        ),
        with: {
          productVariant: { with: { product: { columns: { id: true, name: true, sku: true, reorderPoint: true } } } },
          location: { with: { warehouse: { columns: { id: true, name: true } } } },
        },
        orderBy: [desc(invStockLevels.updatedAt)],
        limit,
        offset,
      });
      return { items: rows, page, limit };
    }, CACHE_TTL.SHORT);
  }

  async listTransactions(orgId: string, filters: ListTransactionsInput) {
    const { productVariantId, locationId, transactionType, fromDate, toDate, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions = [eq(invStockTransactions.orgId, orgId)];
    if (productVariantId) conditions.push(eq(invStockTransactions.productVariantId, productVariantId));
    if (locationId) conditions.push(eq(invStockTransactions.locationId, locationId));
    if (transactionType) conditions.push(eq(invStockTransactions.transactionType, transactionType));
    if (fromDate) conditions.push(gte(invStockTransactions.createdAt, new Date(fromDate)));
    if (toDate) conditions.push(lte(invStockTransactions.createdAt, new Date(toDate)));

    const [items, countResult] = await Promise.all([
      this.db.query.invStockTransactions.findMany({
        where: and(...conditions),
        orderBy: [desc(invStockTransactions.createdAt)],
        limit,
        offset,
        with: {
          productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
          location: { columns: { id: true, name: true, code: true } },
          creator: { columns: { id: true, name: true } },
        },
      }),
      this.db.select({ count: sql<number>`count(*)::int` }).from(invStockTransactions).where(and(...conditions)),
    ]);

    return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
  }

  async listAdjustments(orgId: string, filters: ListAdjustmentsInput) {
    const { page, limit } = filters;
    const offset = (page - 1) * limit;

    const [items, countResult] = await Promise.all([
      this.db.query.invStockAdjustments.findMany({
        where: eq(invStockAdjustments.orgId, orgId),
        orderBy: [desc(invStockAdjustments.createdAt)],
        limit,
        offset,
        with: {
          creator: { columns: { id: true, name: true } },
          lines: { columns: { id: true } },
        },
      }),
      this.db.select({ count: sql<number>`count(*)::int` }).from(invStockAdjustments).where(eq(invStockAdjustments.orgId, orgId)),
    ]);

    return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
  }

  async createAdjustment(orgId: string, userId: string, data: CreateAdjustmentInput): Promise<void> {
    const referenceNumber = nextRefNumber("ADJ");

    const adjVariantIds = [...new Set(data.lines.map((l) => l.productVariantId))];
    const existingLevels = await this.db.query.invStockLevels.findMany({
      where: and(
        eq(invStockLevels.orgId, orgId),
        inArray(invStockLevels.productVariantId, adjVariantIds),
      ),
      columns: { productVariantId: true, locationId: true, onHand: true },
    });
    const levelMap = new Map(existingLevels.map((l) => [`${l.productVariantId}:${l.locationId}`, parseFloat(l.onHand)]));

    await this.db.transaction(async (tx) => {
      const [adj] = await tx.insert(invStockAdjustments).values({
        orgId, referenceNumber, reason: data.reason, notes: data.notes, createdBy: userId,
      }).returning();

      await tx.insert(invStockAdjustmentLines).values(
        data.lines.map((line) => ({
          adjustmentId: adj.id,
          productVariantId: line.productVariantId,
          locationId: line.locationId,
          quantityChange: line.quantityChange.toString(),
          notes: line.notes,
        }))
      );

      for (const line of data.lines) {
        const before = levelMap.get(`${line.productVariantId}:${line.locationId}`) ?? 0;
        const after = before + line.quantityChange;

        await tx.insert(invStockLevels).values({
          orgId,
          productVariantId: line.productVariantId,
          locationId: line.locationId,
          onHand: line.quantityChange.toString(),
        }).onConflictDoUpdate({
          target: [invStockLevels.productVariantId, invStockLevels.locationId],
          set: { onHand: sql`${invStockLevels.onHand} + ${line.quantityChange}`, updatedAt: new Date() },
        });

        await tx.insert(invStockTransactions).values({
          orgId,
          productVariantId: line.productVariantId,
          locationId: line.locationId,
          transactionType: line.quantityChange > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
          quantityChange: line.quantityChange.toString(),
          quantityBefore: before.toString(),
          quantityAfter: after.toString(),
          referenceType: "inv_adjustment",
          referenceId: adj.id.toString(),
          notes: line.notes,
          createdBy: userId,
        });
      }
    });

    await this.cache.del(CACHE_KEYS.invStockSummary(orgId));
    await this.cache.invalidatePattern(`inv:stock:levels:${orgId}:*`);
  }

  async createTransfer(orgId: string, userId: string, data: CreateTransferInput) {
    if (data.fromLocationId === data.toLocationId) {
      throw new BadRequestException("From and to locations must be different");
    }

    const referenceNumber = nextRefNumber("TRF");

    const [transfer] = await this.db.insert(invStockTransfers).values({
      orgId,
      referenceNumber,
      fromLocationId: data.fromLocationId,
      toLocationId: data.toLocationId,
      notes: data.notes,
      createdBy: userId,
    }).returning();

    await this.db.insert(invStockTransferLines).values(
      data.lines.map((line) => ({
        transferId: transfer.id,
        productVariantId: line.productVariantId,
        quantity: line.quantity.toString(),
      }))
    );

    for (const line of data.lines) {
      await this.db.insert(invStockLevels).values({
        orgId,
        productVariantId: line.productVariantId,
        locationId: data.fromLocationId,
        committed: line.quantity.toString(),
      }).onConflictDoUpdate({
        target: [invStockLevels.productVariantId, invStockLevels.locationId],
        set: { committed: sql`${invStockLevels.committed} + ${line.quantity}`, updatedAt: new Date() },
      });
    }

    return transfer;
  }

  async completeTransfer(orgId: string, userId: string, transferId: number, data: CompleteTransferInput): Promise<void> {
    const transfer = await this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: { lines: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING" && transfer.status !== "IN_TRANSIT") {
      throw new BadRequestException("Transfer cannot be completed in its current status");
    }

    const transferVariantIds = transfer.lines.map((l) => l.productVariantId);
    const sourceLevels = await this.db.query.invStockLevels.findMany({
      where: and(
        eq(invStockLevels.orgId, orgId),
        inArray(invStockLevels.productVariantId, transferVariantIds),
        eq(invStockLevels.locationId, transfer.fromLocationId),
      ),
      columns: { productVariantId: true, onHand: true },
    });
    const sourceLevelMap = new Map(sourceLevels.map((l) => [l.productVariantId, parseFloat(l.onHand)]));

    await this.db.transaction(async (tx) => {
      for (const completion of data.lines) {
        const line = transfer.lines.find((l) => l.id === completion.transferLineId);
        if (!line) continue;

        const qtyReceived = completion.quantityReceived;
        const quantityMoved = parseFloat(line.quantity);
        const sourceOnHand = sourceLevelMap.get(line.productVariantId) ?? 0;

        await tx.update(invStockTransferLines)
          .set({ quantityReceived: qtyReceived.toString() })
          .where(eq(invStockTransferLines.id, completion.transferLineId));

        await tx.insert(invStockLevels).values({
          orgId,
          productVariantId: line.productVariantId,
          locationId: transfer.fromLocationId,
          onHand: "0",
        }).onConflictDoUpdate({
          target: [invStockLevels.productVariantId, invStockLevels.locationId],
          set: {
            onHand: sql`${invStockLevels.onHand} - ${line.quantity}`,
            committed: sql`GREATEST(0, ${invStockLevels.committed} - ${line.quantity})`,
            updatedAt: new Date(),
          },
        });

        await tx.insert(invStockLevels).values({
          orgId,
          productVariantId: line.productVariantId,
          locationId: transfer.toLocationId,
          onHand: qtyReceived.toString(),
        }).onConflictDoUpdate({
          target: [invStockLevels.productVariantId, invStockLevels.locationId],
          set: { onHand: sql`${invStockLevels.onHand} + ${qtyReceived}`, updatedAt: new Date() },
        });

        await tx.insert(invStockTransactions).values([
          {
            orgId, productVariantId: line.productVariantId, locationId: transfer.fromLocationId,
            transactionType: "TRANSFER_OUT", quantityChange: `-${quantityMoved}`,
            quantityBefore: sourceOnHand.toString(), quantityAfter: (sourceOnHand - quantityMoved).toString(),
            referenceType: "inv_transfer", referenceId: transferId.toString(), createdBy: userId,
          },
          {
            orgId, productVariantId: line.productVariantId, locationId: transfer.toLocationId,
            transactionType: "TRANSFER_IN", quantityChange: qtyReceived.toString(),
            quantityBefore: "0", quantityAfter: qtyReceived.toString(),
            referenceType: "inv_transfer", referenceId: transferId.toString(), createdBy: userId,
          },
        ]);
      }

      await tx.update(invStockTransfers)
        .set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(invStockTransfers.id, transferId));
    });

    await this.cache.del(CACHE_KEYS.invStockSummary(orgId));
    await this.cache.invalidatePattern(`inv:stock:levels:${orgId}:*`);
  }

  async listTransfers(orgId: string, filters: ListTransfersInput) {
    const { page, limit } = filters;
    const offset = (page - 1) * limit;

    const [items, countResult] = await Promise.all([
      this.db.query.invStockTransfers.findMany({
        where: eq(invStockTransfers.orgId, orgId),
        orderBy: [desc(invStockTransfers.createdAt)],
        limit,
        offset,
        with: {
          fromLocation: { columns: { id: true, name: true, code: true } },
          toLocation: { columns: { id: true, name: true, code: true } },
          creator: { columns: { id: true, name: true } },
          lines: { with: { productVariant: { columns: { id: true, sku: true, name: true } } } },
        },
      }),
      this.db.select({ count: sql<number>`count(*)::int` }).from(invStockTransfers).where(eq(invStockTransfers.orgId, orgId)),
    ]);

    return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
  }

  getTransfer(orgId: string, transferId: number) {
    return this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: {
        fromLocation: true,
        toLocation: true,
        creator: { columns: { id: true, name: true } },
        lines: { with: { productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } } } },
      },
    });
  }
}
