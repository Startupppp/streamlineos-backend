import { ConflictException, Inject, Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  invVendorReturns, invVendorReturnLines, invSerialNumbers, invStockLevels,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { StockEngineService } from "../inv-stock-engine/stock-engine.service";
import { NumberSequenceService } from "../inv-stock-engine/number-sequence.service";
import type { ListReturnsInput, CreateVendorReturnInput, PostVendorReturnInput } from "./dto/inv-returns.schemas";

@Injectable()
export class VendorReturnsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
  ) {}

  async list(orgId: string, filters: ListReturnsInput) {
    const { status, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${status ?? ""}:${limit}:${offset}`;

    return this.cache.cached(`inv:vret:list:${orgId}:${hash}`, async () => {
      const conditions = [eq(invVendorReturns.orgId, orgId)];
      if (status) conditions.push(eq(invVendorReturns.status, status));
      const where = and(...conditions);

      const [items, countResult] = await Promise.all([
        this.db.query.invVendorReturns.findMany({
          where,
          orderBy: [desc(invVendorReturns.createdAt)],
          limit,
          offset,
          with: {
            creator: { columns: { id: true, name: true } },
            lines: true,
          },
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invVendorReturns).where(where),
      ]);

      return {
        items,
        total: countResult[0]?.count ?? 0,
        page,
        totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
      };
    }, CACHE_TTL.SHORT);
  }

  async get(orgId: string, returnId: number) {
    const ret = await this.db.query.invVendorReturns.findFirst({
      where: and(eq(invVendorReturns.id, returnId), eq(invVendorReturns.orgId, orgId)),
      with: {
        creator: { columns: { id: true, name: true } },
        approver: { columns: { id: true, name: true } },
        lines: true,
      },
    });
    if (!ret) throw new NotFoundException("Vendor return not found");
    return ret;
  }

  async create(orgId: string, userId: string, data: CreateVendorReturnInput) {
    const returnNumber = await this.numSeq.next(orgId, "VENDOR_RETURN");

    const [ret] = await this.db.insert(invVendorReturns).values({
      orgId,
      returnNumber,
      vendorId: data.vendorId,
      poId: data.poId,
      grnId: data.grnId,
      notes: data.notes,
      status: "DRAFT",
      createdBy: userId,
    }).returning();

    await this.db.insert(invVendorReturnLines).values(
      data.lines.map((line) => ({
        returnId: ret.id,
        productVariantId: line.productVariantId,
        lotId: line.lotId,
        serialId: line.serialId,
        quantity: line.quantity.toFixed(4),
        reason: line.reason,
        unitCost: line.unitCost,
      }))
    );

    await this.cache.invalidatePattern(`inv:vret:list:${orgId}:*`);
    return this.get(orgId, ret.id);
  }

  async post(
    orgId: string,
    returnId: number,
    userId: string,
    idempotencyKey: string,
    data: PostVendorReturnInput,
  ) {
    const ret = await this.db.query.invVendorReturns.findFirst({
      where: and(eq(invVendorReturns.id, returnId), eq(invVendorReturns.orgId, orgId)),
      with: { lines: true },
    });
    if (!ret) throw new NotFoundException("Vendor return not found");
    if (ret.status === "POSTED") return this.get(orgId, returnId);
    if (ret.status !== "DRAFT") throw new BadRequestException("Only DRAFT vendor returns can be posted");

    const resolvedMovements = await Promise.all(
      ret.lines.map(async (line) => {
        const locationId = await this.resolveLineLocation(orgId, line);
        return {
          transactionType: "VENDOR_RETURN",
          productVariantId: line.productVariantId,
          locationId,
          lotId: line.lotId ?? undefined,
          serialId: line.serialId ?? undefined,
          quantityDelta: `-${line.quantity}`,
          unitCost: line.unitCost ?? undefined,
        };
      })
    );

    try {
      await this.engine.execute(orgId, userId, {
        idempotencyKey,
        sourceType: "inv_vendor_return",
        sourceId: String(returnId),
        reason: data.reason,
        movements: resolvedMovements,
      });
    } catch (err) {
      const isCompletedReplay =
        err instanceof ConflictException &&
        typeof (err as ConflictException & { idempotentResult?: unknown }).idempotentResult !== "undefined";
      if (!isCompletedReplay) throw err;
    }

    const serialLines = ret.lines.filter(
      (l): l is typeof l & { serialId: number } => l.serialId !== null
    );

    await this.db.transaction(async (tx) => {
      if (serialLines.length > 0) {
        await tx.update(invSerialNumbers)
          .set({ status: "RETURNED" })
          .where(inArray(invSerialNumbers.id, serialLines.map((l) => l.serialId)));
      }

      await tx.update(invVendorReturns)
        .set({ status: "POSTED", postedAt: new Date(), approvedBy: userId, updatedAt: new Date() })
        .where(and(eq(invVendorReturns.id, returnId), eq(invVendorReturns.status, "DRAFT")));
    });

    await Promise.all([
      this.cache.invalidatePattern(`inv:vret:list:${orgId}:*`),
      this.cache.del(CACHE_KEYS.invVendorReturnDetail(orgId, returnId)),
    ]);
    return this.get(orgId, returnId);
  }

  private async resolveLineLocation(
    orgId: string,
    line: typeof invVendorReturnLines.$inferSelect,
  ): Promise<number> {
    if (line.serialId) {
      const serial = await this.db.query.invSerialNumbers.findFirst({
        where: eq(invSerialNumbers.id, line.serialId),
        columns: { currentLocationId: true },
      });
      if (serial?.currentLocationId) return serial.currentLocationId;
    }

    const stockLevel = await this.db.query.invStockLevels.findFirst({
      where: and(
        eq(invStockLevels.orgId, orgId),
        eq(invStockLevels.productVariantId, line.productVariantId),
        line.lotId ? eq(invStockLevels.lotId, line.lotId) : undefined,
      ),
      columns: { locationId: true },
      orderBy: (t, { desc }) => [desc(t.onHand)],
    });

    if (stockLevel?.locationId) return stockLevel.locationId;
    throw new BadRequestException(`Cannot determine location for variant ${line.productVariantId} in vendor return`);
  }

  async cancel(orgId: string, returnId: number) {
    const ret = await this.db.query.invVendorReturns.findFirst({
      where: and(eq(invVendorReturns.id, returnId), eq(invVendorReturns.orgId, orgId)),
    });
    if (!ret) throw new NotFoundException("Vendor return not found");
    if (ret.status !== "DRAFT") throw new BadRequestException("Only DRAFT vendor returns can be cancelled");

    await this.db.update(invVendorReturns)
      .set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invVendorReturns.id, returnId), eq(invVendorReturns.orgId, orgId)));

    await this.cache.invalidatePattern(`inv:vret:list:${orgId}:*`);
    return this.get(orgId, returnId);
  }
}
