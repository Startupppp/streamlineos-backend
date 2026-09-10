import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  invVendorReturns, invVendorReturnLines, invSerialNumbers, invStockLevels,
  invVendors, invPurchaseOrders, invGrns,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../stock-engine/warehouse-scope.service";
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

  /**
   * Which vendor returns this caller may see — the list's rule, now the only
   * copy of it.
   *
   * Attributable through the receipt it is sending back, and through nothing
   * else. The GRN names a LOCATION rather than a warehouse, so this goes through
   * `scope.location`, which is a different predicate from the customer half's
   * `scope.warehouse` — matching each aggregate rather than a house default.
   *
   * The NULL rule: a NULL `grn_id` makes `NULL IN (…)` NULL, so a vendor return
   * raised against no receipt is **excluded** from a scoped caller's view. Not
   * the ASN rule, where an unattributed row stays visible to everyone — there a
   * null warehouse means "not known yet", here it means the return is anchored
   * to no receipt and so to no warehouse.
   */
  private returnInScope(orgId: string, scope: ResolvedWarehouseScope): SQL {
    return scope.anyOf(
      sql`${invVendorReturns.grnId} IN (SELECT id FROM inv_grns WHERE org_id = ${orgId} AND ${scope.location(sql.raw("location_id"))})`,
    );
  }

  /**
   * The gate for the mutations that lock the row themselves.
   *
   * `approve` and `post` open with a `SELECT … FOR UPDATE` in raw SQL; they ask
   * this first rather than threading a scope predicate through a statement whose
   * job is locking. 404 on a miss, never 403 (§4).
   */
  private async assertReturnVisible(orgId: string, userId: string, returnId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [visible] = await this.db
      .select({ id: invVendorReturns.id })
      .from(invVendorReturns)
      .where(and(
        eq(invVendorReturns.id, returnId),
        eq(invVendorReturns.orgId, orgId),
        this.returnInScope(orgId, scope),
      ))
      .limit(1);
    if (!visible) throw new NotFoundException("Vendor return not found");
  }

  async list(orgId: string, userId: string, filters: ListReturnsInput) {
    const { status, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${status ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invVendorReturnsNamespace(orgId), hash, async () => {
      const conditions = [
        eq(invVendorReturns.orgId, orgId),
        this.returnInScope(orgId, scope),
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

  /**
   * One vendor return, read by id — and, until now, by anyone in the org.
   *
   * `list` beside it resolves the caller's warehouses; this took no `userId`,
   * because the controller never passed one, so it answered on `org_id` and the
   * return id, and handed back the vendor, the approver and every line.
   */
  async get(orgId: string, userId: string, returnId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.loadVendorReturn(orgId, returnId, this.returnInScope(orgId, scope));
  }

  /**
   * The same read without the warehouse gate, for the paths entitled to it:
   * `create`, which hands back the return it just wrote and would otherwise 404
   * an operator against their own new record, and the tails of `approve`, `post`
   * and `cancel`, each of which has already run the gate.
   *
   * `create`'s claim on it is narrower than it was. It used to cover an RMA
   * anchored to somebody else's receipt, which matched no predicate and so
   * 404ed its own author; `assertSourceInScope` refuses that outright now. What
   * is left is the RMA citing no receipt — anchored to no warehouse, therefore
   * invisible to every scoped operator including the one who just raised it.
   *
   * Named and private so a future route cannot be pointed at the ungated read
   * by accident.
   */
  private loadVendorReturnUnscoped(orgId: string, returnId: number) {
    return this.loadVendorReturn(orgId, returnId, undefined);
  }

  private async loadVendorReturn(orgId: string, returnId: number, inScope: SQL | undefined) {
    const ret = await this.db.query.invVendorReturns.findFirst({
      where: and(
        eq(invVendorReturns.id, returnId),
        eq(invVendorReturns.orgId, orgId),
        inScope,
      ),
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

  /**
   * You may send goods back only off a receipt taken into a warehouse you hold.
   *
   * `create` validated `grn_id` against the ORG and stopped there, so a scoped
   * operator could anchor a DRAFT RMA to a receipt booked into another
   * warehouse. Nothing moved — a DRAFT posts no stock — and every step after it
   * is gated, so the document was invisible to its own author the moment it was
   * saved: a write into a building they hold nothing in, leaving an orphaned
   * draft behind. It also let them measure somebody else's intake, because
   * `assertVendorReturnWithinReceived` below reads that GRN's lines on their
   * behalf and the refusal names the quantity.
   *
   * Through the GRN's LOCATION, matching `returnInScope` above rather than the
   * customer half's `scope.warehouse` — a receipt names the bin it landed in,
   * not the building.
   *
   * `poId` IS DELIBERATELY NOT ASKED ABOUT, the way a transfer asks about its
   * source and not its destination. A vendor return is attributable through the
   * receipt and through nothing else — that is the list's rule and this is the
   * same rule — and a purchase order is raised centrally, so requiring the
   * warehouse operator sending faulty goods back to also hold whatever the PO
   * was attributed to would refuse the ordinary case. `vendorId` is not asked
   * about either: a supplier is not a building. If that is wrong it is wrong as
   * a decision — a spec asserts the PO is not consulted, so tightening it later
   * has to be deliberate rather than drifted into.
   *
   * The NULL rule falls out of the expression rather than being restated: a
   * receipt with no location anchors this return to none of the caller's
   * warehouses, exactly as it is excluded from their list.
   *
   * 404 (§4). The org check in front of it has already told this caller the id
   * exists in their tenant, so the refusal adds nothing by explaining itself.
   */
  private async assertSourceInScope(
    orgId: string,
    userId: string,
    grnId: number | null | undefined,
  ): Promise<void> {
    // An RMA raised against no receipt at all. `assertVendorReturnWithinReceived`
    // makes the same exception: nothing to measure it against, nothing to
    // attribute it to either.
    if (grnId == null) return;

    const scope = await this.warehouseScope.forUser(orgId, userId);
    // Asked before the query rather than compiled to `TRUE` inside it: an
    // org-wide caller is the common case on this path.
    if (scope.unrestricted) return;

    const [inScope] = await this.db
      .select({ id: invGrns.id })
      .from(invGrns)
      .where(and(
        eq(invGrns.id, grnId),
        eq(invGrns.orgId, orgId),
        scope.location(sql`${invGrns.locationId}`),
      ))
      .limit(1);
    if (!inScope) throw new NotFoundException("GRN not found");
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

    // The check above answers "is this id mine to name at all"; it never asked
    // which building the goods were received into. This does.
    await this.assertSourceInScope(orgId, userId, data.grnId);

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
    return this.loadVendorReturnUnscoped(orgId, ret.id);
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
    await this.assertReturnVisible(orgId, userId, returnId);
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
    return this.loadVendorReturnUnscoped(orgId, returnId);
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
    await this.assertReturnVisible(orgId, userId, returnId);
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
    return this.loadVendorReturnUnscoped(orgId, posted);
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

  /**
   * B9. Cancellable from DRAFT and from APPROVED — an approval is reversible
   * until it posts.
   *
   * The customer half's twin, and it took no caller identity either: the
   * controller had `@CurrentUser()` and passed only `orgId`, so any return in
   * the organisation could be cancelled by id from outside the warehouse that
   * raised it. It reads under the list's own predicate now.
   */
  async cancel(orgId: string, userId: string, returnId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const ret = await this.db.query.invVendorReturns.findFirst({
      where: and(
        eq(invVendorReturns.id, returnId),
        eq(invVendorReturns.orgId, orgId),
        this.returnInScope(orgId, scope),
      ),
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
    return this.loadVendorReturnUnscoped(orgId, returnId);
  }
}
