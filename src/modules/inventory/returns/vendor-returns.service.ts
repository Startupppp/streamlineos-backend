import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  invVendorReturns, invVendorReturnLines, invSerialNumbers, invStockLevels,
  invVendors, invPurchaseOrders, invGrns,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
import { assertVendorReturnWithinReceived } from "./returnable-quantity";
import type {
  ListReturnsInput,
  CreateVendorReturnInput,
  PostVendorReturnInput,
  ApproveReturnInput,
} from "./dto/inv-returns.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type VendorReturnLineRow = typeof invVendorReturnLines.$inferSelect;

@Injectable()
export class VendorReturnsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async list(orgId: string, userId: string, filters: ListReturnsInput) {
    const { status, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${status ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invVendorReturnsNamespace(orgId), hash, async () => {
      // Attributable through the receipt it is sending back.
      const conditions = [
        eq(invVendorReturns.orgId, orgId),
        scope.anyOf(
          sql`${invVendorReturns.grnId} IN (SELECT id FROM inv_grns WHERE org_id = ${orgId} AND ${scope.location(sql.raw("location_id"))})`,
        ),
      ];
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
            vendor: { columns: { id: true, name: true } },
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
        vendor: { columns: { id: true, name: true } },
        lines: true,
      },
    });
    if (!ret) throw new NotFoundException("Vendor return not found");
    return ret;
  }

  async create(orgId: string, userId: string, data: CreateVendorReturnInput) {
    const vendor = await this.db.query.invVendors.findFirst({
      where: and(eq(invVendors.id, data.vendorId), eq(invVendors.orgId, orgId)),
      columns: { id: true },
    });
    if (!vendor) throw new BadRequestException("Vendor not found in this organisation");

    if (data.poId != null) {
      const po = await this.db.query.invPurchaseOrders.findFirst({
        where: and(
          eq(invPurchaseOrders.id, data.poId),
          eq(invPurchaseOrders.orgId, orgId),
        ),
        columns: { id: true },
      });
      if (!po) throw new BadRequestException("Purchase order not found in this organisation");
    }

    if (data.grnId != null) {
      const grn = await this.db.query.invGrns.findFirst({
        where: and(
          eq(invGrns.id, data.grnId),
          eq(invGrns.orgId, orgId),
        ),
        columns: { id: true },
      });
      if (!grn) throw new BadRequestException("GRN not found in this organisation");
    }

    // B9, item 3, vendor half: an RMA cannot send back more of a receipt than
    // the receipt brought in. Refused at intake as well as at approval.
    await assertVendorReturnWithinReceived(
      this.db,
      orgId,
      data.grnId ?? null,
      data.lines.map((line) => ({
        productVariantId: line.productVariantId,
        lotId: line.lotId ?? null,
        serialId: line.serialId ?? null,
        quantity: line.quantity,
      })),
    );

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
        orgId,
        returnId: ret.id,
        productVariantId: line.productVariantId,
        lotId: line.lotId,
        serialId: line.serialId,
        quantity: line.quantity,
        reason: line.reason,
        unitCost: line.unitCost,
      }))
    );

    await this.cache.invalidateNamespace(CACHE_KEYS.invVendorReturnsNamespace(orgId));
    return this.get(orgId, ret.id);
  }

  /**
   * B9, item 1 — the same sign-off the customer direction has.
   *
   * A vendor return has no inspection step: the goods are ours and we have
   * looked at them already. What it lacked was anybody agreeing, before the
   * ledger moved, that these goods are going back — and a moment at which that
   * agreement could still be withdrawn.
   */
  async approve(
    orgId: string,
    returnId: number,
    userId: string,
    input: ApproveReturnInput,
  ) {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.execute<{ status: string; grn_id: number | null }>(sql`
        SELECT status, grn_id FROM inv_vendor_returns
        WHERE id = ${returnId} AND org_id = ${orgId} FOR UPDATE`);
      if (!locked) throw new NotFoundException("Vendor return not found");
      if (locked.status === "APPROVED") return;
      if (locked.status !== "DRAFT") {
        throw new BadRequestException(
          `Only DRAFT vendor returns can be approved; this one is ${locked.status}`,
        );
      }

      const lines = await tx
        .select()
        .from(invVendorReturnLines)
        .where(
          and(
            eq(invVendorReturnLines.orgId, orgId),
            eq(invVendorReturnLines.returnId, returnId),
          ),
        );
      if (lines.length === 0)
        throw new BadRequestException("A vendor return with no lines cannot be approved");
      await this.assertReturnableInTx(tx, orgId, locked.grn_id, lines);

      await tx
        .update(invVendorReturns)
        .set({
          status: "APPROVED",
          approvedBy: userId,
          approvedAt: new Date(),
          // Item 5. The vendor credit note this return expects, recorded as a
          // pointer. Nothing here reads it and the stock never waits on it.
          ...(input.creditReference !== undefined
            ? { creditReference: input.creditReference }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(invVendorReturns.id, returnId),
            eq(invVendorReturns.orgId, orgId),
            eq(invVendorReturns.status, "DRAFT"),
          ),
        );
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.invVendorReturnsNamespace(orgId));
    return this.get(orgId, returnId);
  }

  /**
   * The claim spans the whole command rather than the engine call, for the same
   * reason the customer direction's does: a document that posts no movements —
   * here, one whose lines have all been removed — would otherwise claim nothing
   * and be re-runnable.
   */
  async post(
    orgId: string,
    returnId: number,
    userId: string,
    idempotencyKey: string,
    data: PostVendorReturnInput,
  ) {
    const posted = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.vendor-return.post", returnId, reason: data.reason ?? null },
        () => this.postInTx(tx, orgId, returnId, userId, idempotencyKey, data),
        (stored) => {
          const id = revivedId(stored);
          if (!Number.isInteger(id))
            throw new ConflictException("The stored result for this key is unreadable");
          return id;
        },
      ),
    );

    await this.engine.invalidateCaches(orgId);
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.invVendorReturnsNamespace(orgId)),
      this.cache.del(CACHE_KEYS.invVendorReturnDetail(orgId, returnId)),
    ]);
    return this.get(orgId, posted);
  }

  private async postInTx(
    tx: Tx,
    orgId: string,
    returnId: number,
    userId: string,
    idempotencyKey: string,
    data: PostVendorReturnInput,
  ): Promise<number> {
    const [locked] = await tx.execute<{ status: string }>(sql`
      SELECT status FROM inv_vendor_returns
      WHERE id = ${returnId} AND org_id = ${orgId} FOR UPDATE`);
    if (!locked) throw new NotFoundException("Vendor return not found");
    if (locked.status === "POSTED") return returnId;
    if (locked.status !== "APPROVED") {
      throw new BadRequestException(
        locked.status === "DRAFT"
          ? "This vendor return must be approved before it can be posted"
          : `A ${locked.status} vendor return cannot be posted`,
      );
    }

    const ret = await tx.query.invVendorReturns.findFirst({
      where: and(eq(invVendorReturns.id, returnId), eq(invVendorReturns.orgId, orgId)),
      with: { lines: true },
    });
    if (!ret) throw new NotFoundException("Vendor return not found");
    await this.assertReturnableInTx(tx, orgId, ret.grnId, ret.lines);

    const resolvedMovements = await Promise.all(
      ret.lines.map(async (line) => {
        const locationId = await this.resolveLineLocation(tx, orgId, line);
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

    const serialLines = ret.lines.filter(
      (l): l is typeof l & { serialId: number } => l.serialId !== null
    );

    if (resolvedMovements.length > 0) {
      await this.engine.executeInTx(tx, orgId, userId, {
        // Derived: the command's own key is already claimed above.
        idempotencyKey: `${idempotencyKey}:stock`,
        sourceType: "inv_vendor_return",
        sourceId: String(returnId),
        reason: data.reason,
        movements: resolvedMovements,
      });
    }

    if (serialLines.length > 0) {
      await tx.update(invSerialNumbers)
        .set({ status: "RETURNED" })
        .where(inArray(invSerialNumbers.id, serialLines.map((l) => l.serialId)));
    }

    await tx.update(invVendorReturns)
      .set({ status: "POSTED", postedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(invVendorReturns.id, returnId),
        eq(invVendorReturns.orgId, orgId),
        eq(invVendorReturns.status, "APPROVED"),
      ));

    // A5. Same event as a customer return, discriminated by `returnType`:
    // goods leaving on an RMA and goods coming back from a customer are one
    // subscription, not two.
    await emitInventoryCommandEvent(tx, {
      orgId,
      eventType: INVENTORY_COMMAND_EVENTS.RETURN_POSTED,
      aggregateType: "inv_vendor_return",
      aggregateId: String(returnId),
      actorUserId: userId,
      payload: {
        returnType: "VENDOR",
        returnId,
        returnNumber: ret.returnNumber,
        vendorId: ret.vendorId,
        poId: ret.poId,
        grnId: ret.grnId,
        lineCount: ret.lines.length,
        lines: ret.lines.map((line) => ({
          lineId: line.id,
          productVariantId: line.productVariantId,
          reason: line.reason,
        })),
        creditReference: ret.creditReference,
        approvedBy: ret.approvedBy,
        reason: data.reason ?? null,
        idempotencyKey,
      },
    });

    return returnId;
  }

  private assertReturnableInTx(
    tx: Tx,
    orgId: string,
    grnId: number | null,
    lines: VendorReturnLineRow[],
  ): Promise<void> {
    return assertVendorReturnWithinReceived(
      tx,
      orgId,
      grnId === null ? null : Number(grnId),
      lines,
    );
  }

  private async resolveLineLocation(
    tx: Tx,
    orgId: string,
    line: VendorReturnLineRow,
  ): Promise<number> {
    if (line.serialId) {
      const serial = await tx.query.invSerialNumbers.findFirst({
        where: and(
          eq(invSerialNumbers.id, line.serialId),
          eq(invSerialNumbers.orgId, orgId),
        ),
        columns: { currentLocationId: true },
      });
      if (serial?.currentLocationId) return serial.currentLocationId;
    }

    const stockLevel = await tx.query.invStockLevels.findFirst({
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

  /** B9. Cancellable from DRAFT and from APPROVED — an approval is reversible until it posts. */
  async cancel(orgId: string, returnId: number) {
    const ret = await this.db.query.invVendorReturns.findFirst({
      where: and(eq(invVendorReturns.id, returnId), eq(invVendorReturns.orgId, orgId)),
    });
    if (!ret) throw new NotFoundException("Vendor return not found");
    if (ret.status !== "DRAFT" && ret.status !== "APPROVED")
      throw new BadRequestException(`A ${ret.status} vendor return cannot be cancelled`);

    await this.db.update(invVendorReturns)
      .set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(invVendorReturns.id, returnId),
        eq(invVendorReturns.orgId, orgId),
        inArray(invVendorReturns.status, ["DRAFT", "APPROVED"]),
      ));

    await this.cache.invalidateNamespace(CACHE_KEYS.invVendorReturnsNamespace(orgId));
    return this.get(orgId, returnId);
  }
}
