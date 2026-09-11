import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { invStockTransfers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import { StockMovementBridgeService } from "../../accounting/adapters/stock-movement-bridge.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import {
  WarehouseScopeService,
} from "../stock-engine/warehouse-scope.service";
import { TransitLocationService } from "../stock-engine/transit-location.service";
import type { ListTransfersInput, CreateTransferInput, CompleteTransferInput } from "./dto/inv-stock.schemas";
import { loadOrderableVariants } from "../products/lib/orderable-variants";
import {
  assertCommandEnd,
  loadTransfer,
  transferInScope,
} from "./lib/transfer-scope";
import {
  cancelTransferInTx,
  createTransferInTx,
  reserveTransferInTx,
} from "./lib/transfer-commands";
import type { TransferDeps } from "./lib/transfer-movement";
import { dispatchTransfer } from "./lib/transfer-dispatch";
import { completeTransfer } from "./lib/transfer-complete";



@Injectable()
export class InvStockTransfersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly reservationService: ReservationService,
    private readonly numSeq: NumberSequenceService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly transitLocations: TransitLocationService,
    private readonly glBridge: StockMovementBridgeService,
  ) {}


  private async assertScopedTransfer(orgId: string, userId: string, transferId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const found = await loadTransfer(this.db, orgId, transferId, transferInScope(scope));
    // 404 rather than 403: a "forbidden" on a transfer id confirms the transfer
    // exists, which turns a probe into an existence oracle (§4).
    if (!found) throw new NotFoundException("Transfer not found");
    return found;
  }

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
    if (userId) {
      // A transfer is in scope only if BOTH ends are — seeing one leg would
      // expose the counterpart warehouse's stock movement.
      conditions.push(transferInScope(await this.warehouseScope.forUser(orgId, userId)));
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

  async getTransfer(orgId: string, userId: string, transferId: number) {
    return this.assertScopedTransfer(orgId, userId, transferId);
  }

  // B1-04: Header + lines inserted in a single transaction.
  /**
   * The route demanded an `Idempotency-Key` and then called this without it —
   * the same defect `reserveTransfer` below documents, one step earlier and
   * with no status guard to soften it. A retried create took a second reference
   * number from the sequence and wrote a second transfer document for the same
   * goods, so the duplicate was indistinguishable from a real one.
   */
  async createTransfer(
    orgId: string,
    userId: string,
    data: CreateTransferInput,
    idempotencyKey: string,
  ) {
    if (data.fromLocationId === data.toLocationId) {
      throw new BadRequestException("From and to locations must be different");
    }

    /*
     * You may send stock only out of a building you hold.
     *
     * `createTransferInTx` below is two plain inserts — no stock engine, no
     * movements — so nothing checked either location, and `fromLocationId` came
     * straight off the request body. Any holder of the create permission could
     * draft a transfer OUT of any warehouse in the organisation. The engine's
     * `assertLocationsInScope` only bites later, when movements actually post,
     * and only when there are movements to post.
     *
     * THE SOURCE IS ASSERTED AND THE DESTINATION DELIBERATELY IS NOT, and that
     * asymmetry is a product rule rather than an oversight: an operator in one
     * building sending stock to another is the ordinary case, and they will
     * routinely hold no part of the destination. Requiring both would refuse
     * every legitimate inter-warehouse transfer made by the people who make
     * them. Taking stock OUT of a building you hold nothing in is the move that
     * has no honest reading.
     *
     * 404 rather than 403, so naming a location you cannot see does not confirm
     * it exists.
     */
    await this.warehouseScope.assertLocationVisible(orgId, userId, data.fromLocationId);

    // A4. Moving a discontinued SKU between warehouses is new demand on it —
    // the goods have to be picked, counted and put away somewhere — and the
    // lifecycle gate covered selling but not this.
    await loadOrderableVariants(this.db, orgId, data.lines.map((l) => l.productVariantId));

    const transferId = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.transfers.create", input: data },
        () => createTransferInTx(this.numSeq, tx, orgId, userId, data),
        revivedId,
      ),
    );

    // Unscoped on purpose: the caller's standing was settled by the source
    // assert above, and the create rule lets them name a destination they do
    // not hold — so the list's both-ends predicate would 404 them the document
    // they have just raised.
    const transfer = await loadTransfer(this.db, orgId, transferId, null);
    if (!transfer) throw new NotFoundException("Transfer not found after create");
    return transfer;
  }


  // B1-03: All line reservations created atomically in one transaction.
  /**
   * A3. The route demanded an `Idempotency-Key` and then called this without it.
   *
   * The status guard made a retry safe but not *correct*: the second call found
   * the transfer already RESERVED and threw 400, so a client retrying a request
   * that had actually succeeded — the usual reason to retry — was told its
   * transfer could not be reserved. Replaying the original answer is the point
   * of the key.
   */
  /**
   * Holds the stock the transfer will take, at the SOURCE bin.
   *
   * This was the sharpest of the four. Nothing downstream catches it, and here
   * that is a rule rather than an omission: a reservation is a soft hold that
   * posts no movement, so `ReservationService` never reaches the stock engine
   * and `assertLocationsInScope` never runs. `reserveTransferInTx` locked the
   * row on `org_id` and the id alone, so any holder of the transfer permission
   * could take another building's stock out of its available pool — the goods
   * stay on the shelf and stop being sellable, and the keeper there sees their
   * availability fall with no document of their own to explain it.
   *
   * Gated on the entry read so an out-of-scope attempt never reaches the
   * idempotency claim and cannot burn a key either.
   */
  async reserveTransfer(orgId: string, userId: string, transferId: number, idempotencyKey: string) {
    await assertCommandEnd(this.db, this.warehouseScope, orgId, userId, transferId, "source");

    const transfer = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.transfers.reserve", transferId },
        () => reserveTransferInTx(this.reservationService, tx, orgId, userId, transferId, idempotencyKey),
        revivedId,
      ),
    );

    // Unscoped for the same reason `createTransfer` is: the source gate above
    // has already settled this caller's standing, and the both-ends predicate
    // would refuse them a transfer they were entitled to reserve.
    return loadTransfer(this.db, orgId, transfer, null);
  }


  /**
   * The dependency bag the movement commands take. Built explicitly rather than
   * passing `this`: the constructor fields are `private`, and TypeScript will not
   * structurally match a class with private members to an interface.
   */
  private get transferDeps(): TransferDeps {
    return {
      db: this.db,
      cache: this.cache,
      engine: this.engine,
      reservationService: this.reservationService,
      transitLocations: this.transitLocations,
      warehouseScope: this.warehouseScope,
      glBridge: this.glBridge,
    };
  }

  /** @see lib/transfer-movement.ts — the body moved, the route surface did not. */
  async dispatchTransfer(orgId: string, userId: string, transferId: number, idempotencyKey: string) {
    return dispatchTransfer(this.transferDeps, orgId, userId, transferId, idempotencyKey);
  }


  /** @see lib/transfer-movement.ts — the body moved, the route surface did not. */
  async completeTransfer(orgId: string, userId: string, transferId: number, data: CompleteTransferInput, idempotencyKey: string) {
    return completeTransfer(this.transferDeps, orgId, userId, transferId, data, idempotencyKey);
  }

  // B1-20/21: Cancel releases reservations (via releaseReservationInTx in one tx) and
  // invalidates stock summary + stock level caches.
  /**
   * A3. Cancelling took no key at all. The status guard makes a repeat safe, but
   * a client retrying a timed-out cancel was told the transfer could not be
   * cancelled — the request had in fact succeeded.
   */
  async cancelTransfer(orgId: string, userId: string, transferId: number, idempotencyKey: string) {
    /*
     * The SOURCE end. Cancelling releases the reservations this transfer holds
     * at the source bin and flips the document terminal, and both are the source
     * keeper's business.
     *
     * Nothing downstream catches this one either: cancel posts no movements at
     * all — it stops at RESERVED by design, so there is never anything in
     * transit to unwind — which means the stock engine is not on this path and
     * `assertLocationsInScope` never runs. So a stranger could cancel another
     * building's transfer outright: the reservations are released, the document
     * goes CANCELLED, and nothing is visible until goods that were supposed to
     * leave have not left.
     */
    await assertCommandEnd(this.db, this.warehouseScope, orgId, userId, transferId, "source");

    const transfer = await this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      // Existence only — the status check moved inside the claim.
      columns: { id: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    // A2. Deliberately unchanged. Cancelling stops at RESERVED, so no cancel can
    // strand goods at a transit location -- there is nothing there to strand
    // until a dispatch has happened. The gap that did exist was the other way
    // round: an IN_TRANSIT transfer had no terminal state but COMPLETED, so a
    // journey that was abandoned, or completed short, left its stock standing in
    // transit with no route out. R3 closes that with `TransitExitService`, which
    // is the state-machine decision it needed -- goods return to the source bin
    // or are written off, both as posted movements -- rather than a wider cancel
    // that would have had to move stock it never named.

    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.transfers.cancel", transferId },
        async () => {
          // T04. This check used to sit in front of `runIdempotent`, where cancel's
          // own effect invalidated it — the comment above says exactly that, and the
          // guard was left outside anyway. At HTTP the controller's `@Idempotent`
          // fence hid it; a service-level caller had no such cover. Read through `tx`
          // so the check sees the same snapshot the write does.
          const [current] = await tx.select({ status: invStockTransfers.status })
            .from(invStockTransfers)
            .where(and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)))
            .limit(1);
          if (!current) throw new NotFoundException("Transfer not found");
          if (current.status !== "PENDING" && current.status !== "RESERVED") {
            throw new BadRequestException("Only PENDING or RESERVED transfers can be cancelled");
          }
          return cancelTransferInTx(this.reservationService, tx, orgId, userId, transferId, current.status);
        },
        () => ({ cancelled: transferId }),
      ),
    );

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.invStockSummary(orgId)),
      this.cache.invalidateNamespace(`inv:stock:levels:${orgId}`),
      this.cache.invalidateNamespace(`inv:reservations:list:${orgId}`),
    ]);
  }

}
