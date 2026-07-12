import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { invStockTransfers, invStockTransferLines } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { StockEngineService } from "../inv-stock-engine/stock-engine.service";
import { ReservationService } from "../inv-stock-engine/reservation.service";
import { NumberSequenceService } from "../inv-stock-engine/number-sequence.service";
import type { ListTransfersInput, CreateTransferInput, CompleteTransferInput } from "./dto/inv-stock.schemas";

@Injectable()
export class InvStockTransfersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly reservationService: ReservationService,
    private readonly numSeq: NumberSequenceService,
  ) {}

  async listTransfers(orgId: string, filters: ListTransfersInput, scope: DataScope = "all", userId?: string) {
    if (scope === "none") return { items: [], total: 0, page: filters.page, totalPages: 0 };

    const { status, warehouseId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions = [eq(invStockTransfers.orgId, orgId)];
    if (status) conditions.push(eq(invStockTransfers.status, status));
    if (warehouseId) conditions.push(eq(invStockTransfers.fromWarehouseId, warehouseId) as ReturnType<typeof eq>);
    if (scope !== "all" && userId) {
      conditions.push(applyScope(scope, userId, { ownerColumn: invStockTransfers.createdBy }));
    }
    const where = and(...conditions);

    const [items, countResult] = await Promise.all([
      this.db.query.invStockTransfers.findMany({
        where,
        orderBy: [desc(invStockTransfers.createdAt)],
        limit,
        offset,
        with: {
          fromLocation: { columns: { id: true, name: true, code: true } },
          toLocation: { columns: { id: true, name: true, code: true } },
          fromWarehouse: { columns: { id: true, name: true } },
          toWarehouse: { columns: { id: true, name: true } },
          creator: { columns: { id: true, name: true } },
          lines: { with: { productVariant: { columns: { id: true, sku: true, name: true } } } },
        },
      }),
      this.db.select({ count: sql<number>`count(*)::int` }).from(invStockTransfers).where(where),
    ]);

    return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
  }

  getTransfer(orgId: string, transferId: number) {
    return this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: {
        fromLocation: true,
        toLocation: true,
        fromWarehouse: { columns: { id: true, name: true } },
        toWarehouse: { columns: { id: true, name: true } },
        creator: { columns: { id: true, name: true } },
        lines: {
          with: {
            productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
            lot: { columns: { id: true, lotNumber: true } },
            serial: { columns: { id: true, serialNumber: true } },
          },
        },
      },
    });
  }

  async createTransfer(orgId: string, userId: string, data: CreateTransferInput) {
    if (data.fromLocationId === data.toLocationId) {
      throw new BadRequestException("From and to locations must be different");
    }

    const referenceNumber = await this.numSeq.next(orgId, "TRANSFER");
    const [transfer] = await this.db.insert(invStockTransfers).values({
      orgId,
      referenceNumber,
      fromLocationId: data.fromLocationId,
      toLocationId: data.toLocationId,
      fromWarehouseId: data.fromWarehouseId ?? null,
      toWarehouseId: data.toWarehouseId ?? null,
      notes: data.notes,
      createdBy: userId,
    }).returning();

    await this.db.insert(invStockTransferLines).values(
      data.lines.map((line) => ({
        transferId: transfer.id,
        productVariantId: line.productVariantId,
        quantity: line.quantity.toString(),
        lotId: line.lotId ?? null,
        serialId: line.serialId ?? null,
      }))
    );

    return transfer;
  }

  async reserveTransfer(orgId: string, userId: string, transferId: number, idempotencyKey: string) {
    const transfer = await this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: { lines: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING") throw new BadRequestException("Only PENDING transfers can be reserved");

    for (const line of transfer.lines) {
      await this.reservationService.createReservation(orgId, userId, {
        sourceType: "inv_transfer",
        sourceId: transferId.toString(),
        sourceLineId: line.id.toString(),
        productVariantId: line.productVariantId,
        locationId: transfer.fromLocationId,
        lotId: line.lotId ?? undefined,
        serialId: line.serialId ?? undefined,
        qty: line.quantity,
      });
    }

    await this.db.update(invStockTransfers)
      .set({ status: "RESERVED", reservedAt: new Date() })
      .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));

    return this.getTransfer(orgId, transferId);
  }

  async dispatchTransfer(orgId: string, userId: string, transferId: number, idempotencyKey: string) {
    const transfer = await this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: { lines: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING" && transfer.status !== "RESERVED") {
      throw new BadRequestException("Only PENDING or RESERVED transfers can be dispatched");
    }

    await this.engine.execute(orgId, userId, {
      idempotencyKey,
      sourceType: "inv_transfer",
      sourceId: transferId.toString(),
      reason: `Dispatch transfer ${transfer.referenceNumber}`,
      movements: transfer.lines.map((line) => ({
        transactionType: "TRANSFER_OUT",
        productVariantId: line.productVariantId,
        locationId: transfer.fromLocationId,
        quantityDelta: `-${line.quantity}`,
        lotId: line.lotId ?? undefined,
        serialId: line.serialId ?? undefined,
      })),
    });

    if (transfer.status === "RESERVED") {
      const reservations = await this.db.execute<{ id: number }>(sql`
        SELECT id FROM inv_stock_reservations
        WHERE org_id = ${orgId} AND source_type = 'inv_transfer' AND source_id = ${transferId.toString()} AND status = 'ACTIVE'
      `);
      for (const res of reservations) {
        await this.reservationService.consumeReservation(orgId, userId, res.id);
      }
    }

    await this.db.update(invStockTransfers)
      .set({ status: "IN_TRANSIT", dispatchedAt: new Date() })
      .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));
  }

  async completeTransfer(orgId: string, userId: string, transferId: number, data: CompleteTransferInput, idempotencyKey: string) {
    const transfer = await this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: { lines: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "IN_TRANSIT" && transfer.status !== "PENDING" && transfer.status !== "RESERVED") {
      throw new BadRequestException("Transfer cannot be completed in its current status");
    }

    const movements = data.lines
      .map((completion) => {
        const line = transfer.lines.find((l) => l.id === completion.transferLineId);
        if (!line || completion.quantityReceived <= 0) return null;
        return {
          transactionType: "TRANSFER_IN" as const,
          productVariantId: line.productVariantId,
          locationId: transfer.toLocationId,
          quantityDelta: completion.quantityReceived.toFixed(4),
          lotId: line.lotId ?? undefined,
          serialId: line.serialId ?? undefined,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    await this.engine.execute(orgId, userId, {
      idempotencyKey,
      sourceType: "inv_transfer",
      sourceId: transferId.toString(),
      reason: `Complete transfer ${transfer.referenceNumber}`,
      movements,
    });

    for (const completion of data.lines) {
      const line = transfer.lines.find((l) => l.id === completion.transferLineId);
      if (!line) continue;
      await this.db.update(invStockTransferLines)
        .set({ quantityReceived: completion.quantityReceived.toString() })
        .where(eq(invStockTransferLines.id, completion.transferLineId));
    }

    await this.db.update(invStockTransfers)
      .set({ status: "COMPLETED", completedAt: new Date() })
      .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));
  }

  async cancelTransfer(orgId: string, userId: string, transferId: number) {
    const transfer = await this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      columns: { id: true, status: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING" && transfer.status !== "RESERVED") {
      throw new BadRequestException("Only PENDING or RESERVED transfers can be cancelled");
    }

    if (transfer.status === "RESERVED") {
      const reservations = await this.db.execute<{ id: number }>(sql`
        SELECT id FROM inv_stock_reservations
        WHERE org_id = ${orgId} AND source_type = 'inv_transfer' AND source_id = ${transferId.toString()} AND status = 'ACTIVE'
      `);
      for (const res of reservations) {
        await this.reservationService.releaseReservation(orgId, userId, res.id);
      }
    }

    await this.db.update(invStockTransfers)
      .set({ status: "CANCELLED" })
      .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));

    await this.cache.invalidate(CACHE_KEYS.invStockSummary(orgId));
    await this.cache.invalidatePattern(CACHE_KEYS.invStockLevelPattern(orgId));
  }
}
