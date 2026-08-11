import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { invStockTransfers, invStockTransferLines, invStockReservations, invStockTransactions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import type { ListTransfersInput, CreateTransferInput, CompleteTransferInput } from "./dto/inv-stock.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

    const { status, warehouseId, fromWarehouseId, toWarehouseId, fromDate, toDate, search, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions: SQL[] = [eq(invStockTransfers.orgId, orgId)];
    if (status) conditions.push(eq(invStockTransfers.status, status));
    if (warehouseId) conditions.push(eq(invStockTransfers.fromWarehouseId, warehouseId));
    if (fromWarehouseId) conditions.push(eq(invStockTransfers.fromWarehouseId, fromWarehouseId));
    if (toWarehouseId) conditions.push(eq(invStockTransfers.toWarehouseId, toWarehouseId));
    if (fromDate) conditions.push(gte(invStockTransfers.createdAt, new Date(fromDate)));
    if (toDate) conditions.push(lte(invStockTransfers.createdAt, new Date(toDate)));
    if (search) {
      const term = `%${search}%`;
      conditions.push(
        sql`(
          ${invStockTransfers.referenceNumber} ILIKE ${term}
          OR ${invStockTransfers.notes} ILIKE ${term}
          OR EXISTS (
            SELECT 1 FROM inv_locations fl WHERE fl.id = ${invStockTransfers.fromLocationId} AND (fl.name ILIKE ${term} OR fl.code ILIKE ${term})
          )
          OR EXISTS (
            SELECT 1 FROM inv_locations tl WHERE tl.id = ${invStockTransfers.toLocationId} AND (tl.name ILIKE ${term} OR tl.code ILIKE ${term})
          )
          OR EXISTS (
            SELECT 1 FROM inv_stock_transfer_lines stl
            JOIN inv_product_variants pv ON pv.id = stl.product_variant_id
            JOIN inv_products p ON p.id = pv.product_id
            WHERE stl.transfer_id = ${invStockTransfers.id}
            AND (p.name ILIKE ${term} OR pv.sku ILIKE ${term} OR p.sku ILIKE ${term})
          )
        )`,
      );
    }
    if (scope !== "all" && userId) {
      conditions.push(applyScope(scope, orgId, userId, { ownerColumn: invStockTransfers.createdBy }));
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

  // B1-04: Header + lines inserted in a single transaction.
  async createTransfer(orgId: string, userId: string, data: CreateTransferInput) {
    if (data.fromLocationId === data.toLocationId) {
      throw new BadRequestException("From and to locations must be different");
    }

    const transfer = await this.db.transaction(async (tx) => {
      const referenceNumber = await this.numSeq.next(orgId, "TRANSFER", tx);
      const [created] = await tx.insert(invStockTransfers).values({
        orgId,
        referenceNumber,
        fromLocationId: data.fromLocationId,
        toLocationId: data.toLocationId,
        fromWarehouseId: data.fromWarehouseId ?? null,
        toWarehouseId: data.toWarehouseId ?? null,
        notes: data.notes,
        createdBy: userId,
      }).returning();

      await tx.insert(invStockTransferLines).values(
        data.lines.map((line) => ({
          transferId: created!.id,
          productVariantId: line.productVariantId,
          quantity: line.quantity.toString(),
          lotId: line.lotId ?? null,
          serialId: line.serialId ?? null,
        }))
      );

      return created!;
    });

    return transfer;
  }

  // B1-03: All line reservations created atomically in one transaction.
  async reserveTransfer(orgId: string, userId: string, transferId: number) {
    const transfer = await this.db.transaction(async (tx) => {
      const [locked] = await tx.execute<{
        id: number; status: string; from_location_id: number; org_id: string;
      }>(sql`
        SELECT id, status, from_location_id, org_id
        FROM inv_stock_transfers
        WHERE id = ${transferId} AND org_id = ${orgId}
        FOR UPDATE
      `);

      if (!locked) throw new NotFoundException("Transfer not found");
      if (locked.status !== "PENDING") throw new BadRequestException("Only PENDING transfers can be reserved");

      const lines = await tx.query.invStockTransferLines.findMany({
        where: eq(invStockTransferLines.transferId, transferId),
      });

      for (const line of lines) {
        await this.reservationService.createReservationInTx(tx, orgId, userId, {
          sourceType: "inv_transfer",
          sourceId: transferId.toString(),
          sourceLineId: line.id.toString(),
          productVariantId: line.productVariantId,
          locationId: locked.from_location_id,
          lotId: line.lotId ?? undefined,
          serialId: line.serialId ?? undefined,
          qty: line.quantity,
        });
      }

      await tx.update(invStockTransfers)
        .set({ status: "RESERVED", reservedAt: new Date() })
        .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));

      return transferId;
    });

    return this.getTransfer(orgId, transfer);
  }

  // B1-06: engine.executeInTx + reservation consumption + status update in one transaction.
  // invalidateCaches (stock levels + reservations list) called after the outer tx commits.
  async dispatchTransfer(orgId: string, userId: string, transferId: number, idempotencyKey: string) {
    const transfer = await this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: { lines: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING" && transfer.status !== "RESERVED") {
      throw new BadRequestException("Only PENDING or RESERVED transfers can be dispatched");
    }

    await this.db.transaction(async (tx) => {
      const result = await this.engine.executeInTx(tx, orgId, userId, {
        idempotencyKey,
        sourceType: "inv_transfer",
        sourceId: transferId.toString(),
        reason: `Dispatch transfer ${transfer.referenceNumber}`,
        movements: transfer.lines.map((line) => ({
          transactionType: "TRANSFER_OUT" as const,
          productVariantId: line.productVariantId,
          locationId: transfer.fromLocationId,
          quantityDelta: `-${line.quantity}`,
          lotId: line.lotId ?? undefined,
          serialId: line.serialId ?? undefined,
        })),
      });

      // Carry the cost the source layers were actually consumed at onto the
      // line, so completion can rebuild it at the destination. Cost layers are
      // keyed per location, so without this the stock arrives with no basis.
      await this.stampDispatchedCost(tx, orgId, transfer.lines, result.transactionIds);

      if (transfer.status === "RESERVED") {
        const activeReservations = await tx
          .select({
            id: invStockReservations.id,
            locationId: invStockReservations.locationId,
            productVariantId: invStockReservations.productVariantId,
            reservedQty: invStockReservations.reservedQty,
          })
          .from(invStockReservations)
          .where(and(
            eq(invStockReservations.orgId, orgId),
            eq(invStockReservations.sourceType, "inv_transfer"),
            eq(invStockReservations.sourceId, transferId.toString()),
            eq(invStockReservations.status, "ACTIVE"),
          ));

        await this.reservationService.consumeReservationsBatch(tx, orgId, userId, activeReservations);
      }

      await tx.update(invStockTransfers)
        .set({ status: "IN_TRANSIT", dispatchedAt: new Date() })
        .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));
    });

    await Promise.all([
      this.engine.invalidateCaches(orgId),
      this.cache.invalidateNamespace(`inv:reservations:list:${orgId}`),
    ]);
  }

  /**
   * Reads back the unit cost the engine derived for each TRANSFER_OUT and stores
   * it on the matching transfer line. Matched on (variant, lot) because a
   * transfer may move several lots of the same variant.
   */
  private async stampDispatchedCost(
    tx: Tx,
    orgId: string,
    lines: ReadonlyArray<{ id: number; productVariantId: number; lotId: number | null }>,
    transactionIds: readonly number[],
  ): Promise<void> {
    if (transactionIds.length === 0) return;

    const txns = await tx
      .select({
        productVariantId: invStockTransactions.productVariantId,
        lotId: invStockTransactions.lotId,
        unitCost: invStockTransactions.unitCost,
      })
      .from(invStockTransactions)
      .where(and(
        eq(invStockTransactions.orgId, orgId),
        inArray(invStockTransactions.id, [...transactionIds]),
      ));

    const costByKey = new Map<string, string>();
    for (const t of txns)
      if (t.unitCost) costByKey.set(`${t.productVariantId}:${t.lotId ?? ""}`, t.unitCost);

    for (const line of lines) {
      const cost = costByKey.get(`${line.productVariantId}:${line.lotId ?? ""}`);
      if (!cost) continue;
      await tx.update(invStockTransferLines)
        .set({ dispatchedUnitCost: cost })
        .where(eq(invStockTransferLines.id, line.id));
    }
  }

  // B1-07: engine.executeInTx + line quantityReceived updates + status update in one transaction.
  // invalidateCaches called after.
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
          unitCost: line.dispatchedUnitCost ?? undefined,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    await this.db.transaction(async (tx: Tx) => {
      await this.engine.executeInTx(tx, orgId, userId, {
        idempotencyKey,
        sourceType: "inv_transfer",
        sourceId: transferId.toString(),
        reason: `Complete transfer ${transfer.referenceNumber}`,
        movements,
      });

      for (const completion of data.lines) {
        const line = transfer.lines.find((l) => l.id === completion.transferLineId);
        if (!line) continue;
        await tx.update(invStockTransferLines)
          .set({ quantityReceived: completion.quantityReceived.toString() })
          .where(and(
            eq(invStockTransferLines.id, completion.transferLineId),
            eq(invStockTransferLines.transferId, transferId),
          ));
      }

      await tx.update(invStockTransfers)
        .set({ status: "COMPLETED", completedAt: new Date() })
        .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));
    });

    await this.engine.invalidateCaches(orgId);
  }

  // B1-20/21: Cancel releases reservations (via releaseReservationInTx in one tx) and
  // invalidates stock summary + stock level caches.
  async cancelTransfer(orgId: string, userId: string, transferId: number) {
    const transfer = await this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      columns: { id: true, status: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING" && transfer.status !== "RESERVED") {
      throw new BadRequestException("Only PENDING or RESERVED transfers can be cancelled");
    }

    await this.db.transaction(async (tx) => {
      if (transfer.status === "RESERVED") {
        const activeReservations = await tx
          .select({ id: invStockReservations.id })
          .from(invStockReservations)
          .where(and(
            eq(invStockReservations.orgId, orgId),
            eq(invStockReservations.sourceType, "inv_transfer"),
            eq(invStockReservations.sourceId, transferId.toString()),
            eq(invStockReservations.status, "ACTIVE"),
          ));

        for (const res of activeReservations) {
          await this.reservationService.releaseReservationInTx(tx, orgId, userId, res.id);
        }
      }

      await tx.update(invStockTransfers)
        .set({ status: "CANCELLED" })
        .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));
    });

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.invStockSummary(orgId)),
      this.cache.invalidateNamespace(`inv:stock:levels:${orgId}`),
      this.cache.invalidateNamespace(`inv:reservations:list:${orgId}`),
    ]);
  }
}
