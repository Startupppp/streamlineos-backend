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
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
import { ReservationService } from "../stock-engine/reservation.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../stock-engine/warehouse-scope.service";
import { TransitLocationService } from "../stock-engine/transit-location.service";
import type { ListTransfersInput, CreateTransferInput, CompleteTransferInput } from "./dto/inv-stock.schemas";
import { loadOrderableVariants } from "../products/lib/orderable-variants";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The grain a transfer's cost is carried at. Valuation layers are keyed per
 * (variant, location, lot) and know nothing about serials, so a serial is not
 * part of this key.
 */
function costKey(line: { productVariantId: number; lotId: number | null }): string {
  return `${line.productVariantId}:${line.lotId ?? ""}`;
}

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
  ) {}

  /**
   * Which transfers this caller may see — the list's rule, now the only copy.
   *
   * BOTH ends, because a transfer is one document about two buildings: seeing a
   * single leg exposes the counterpart warehouse's movement, which is the rule
   * `listTransfers` has applied since the warehouse work landed and the one the
   * loads fix already borrowed for a transfer on a load line.
   *
   * The NULL half is worth stating because it differs by table on purpose.
   * `locationPredicate` renders `location_id IN (SELECT …)`, so a transfer whose
   * end is attributed to no location evaluates to NULL and is EXCLUDED for a
   * scoped caller — exactly what the list already did. That is not the handling
   * unit's rule, which keeps an `IS NULL` escape because a unit nested inside
   * another genuinely has no location of its own. Each detail follows its own
   * aggregate.
   *
   * Private and single so the detail and the four commands cannot drift from the
   * list: two hand-copied predicates agreeing today is not the same as them
   * being one predicate, and the list gaining a scope the rest were never told
   * about is the whole defect.
   */
  private transferInScope(scope: ResolvedWarehouseScope): SQL {
    return sql`(${this.transferSourceInScope(scope)} AND ${this.transferDestinationInScope(scope)})`;
  }

  /**
   * The building the goods leave from, and the authority every command that
   * touches the SOURCE is measured against.
   *
   * The four commands below deliberately do NOT take `transferInScope` above,
   * and the reason is written into `createTransfer`: the source is asserted on
   * create and the destination is not, because an operator in one building
   * sending stock to another routinely holds no part of the destination.
   * Gating `reserve`, `dispatch` and `cancel` on both ends would therefore
   * refuse the very operator the create rule exists to allow — they could raise
   * an inter-warehouse transfer and then not reserve or dispatch it.
   *
   * So each command asks about the end it actually touches, and asks it through
   * this one definition rather than spelling out a fresh `scope.location(...)`
   * call per method. The list's pair is composed from the same two halves, so
   * nothing here can drift from the list either.
   */
  private transferSourceInScope(scope: ResolvedWarehouseScope): SQL {
    return scope.location(sql`${invStockTransfers.fromLocationId}`);
  }

  /**
   * The building the goods arrive in. `completeTransfer` is a receipt, so this
   * is the end that answers for it — the same end the stock engine will assert
   * on the arrival movement a moment later.
   */
  private transferDestinationInScope(scope: ResolvedWarehouseScope): SQL {
    return scope.location(sql`${invStockTransfers.toLocationId}`);
  }

  /**
   * One transfer, read whole, through whatever gate the caller earned.
   *
   * `gate` is `null` only for the two paths that have ALREADY settled the
   * caller's standing on the way in — `createTransfer` and `reserveTransfer`
   * both end by returning the document they just acted on, and both asserted
   * the source before they touched it. Handing them the list's both-ends
   * predicate would 404 an operator the transfer they have this instant
   * created, because the create rule lets them name a destination they do not
   * hold. Named so nobody routes to it by accident.
   */
  private async loadTransfer(orgId: string, transferId: number, gate: SQL | null) {
    return this.db.query.invStockTransfers.findFirst({
      where: gate === null
        ? and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId))
        : and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId), gate),
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

  /**
   * Reads the header, its lines, both bins, both buildings and who raised it.
   *
   * It took no `userId` at all — the controller had `@CurrentUser()` in hand and
   * passed only `orgId` — while the list beside it has narrowed on both ends
   * since the warehouse work landed. So a transfer an operator could not see in
   * their list was theirs to read whole by id, including the counterpart
   * warehouse's bin, quantities, lots and serials. Nothing downstream would have
   * caught it: a read posts no movements, so the engine's
   * `assertLocationsInScope` never runs on this path.
   *
   * Not cached, so there is no key to carry a scope discriminator — but if one
   * is ever added it must carry `scope.key`, or this becomes worse than the
   * unscoped read it replaces (§6).
   */
  /**
   * The object gate for a command, on the end that command actually touches.
   *
   * A projection rather than the whole document: this refuses BEFORE the status
   * is read, so a caller who may not see a transfer is told "not found" rather
   * than "only PENDING transfers can be reserved", which would report the
   * document's state to them. 404, never 403 (§4).
   */
  private async assertCommandEnd(
    orgId: string,
    userId: string,
    transferId: number,
    end: "source" | "destination",
  ): Promise<void> {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    if (scope.unrestricted) return;
    const [visible] = await this.db
      .select({ id: invStockTransfers.id })
      .from(invStockTransfers)
      .where(
        and(
          eq(invStockTransfers.id, transferId),
          eq(invStockTransfers.orgId, orgId),
          end === "source"
            ? this.transferSourceInScope(scope)
            : this.transferDestinationInScope(scope),
        ),
      )
      .limit(1);
    if (!visible) throw new NotFoundException("Transfer not found");
  }

  private async assertScopedTransfer(orgId: string, userId: string, transferId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const found = await this.loadTransfer(orgId, transferId, this.transferInScope(scope));
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
      conditions.push(this.transferInScope(await this.warehouseScope.forUser(orgId, userId)));
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
        () => this.createTransferInTx(tx, orgId, userId, data),
        revivedId,
      ),
    );

    // Unscoped on purpose: the caller's standing was settled by the source
    // assert above, and the create rule lets them name a destination they do
    // not hold — so the list's both-ends predicate would 404 them the document
    // they have just raised.
    const transfer = await this.loadTransfer(orgId, transferId, null);
    if (!transfer) throw new NotFoundException("Transfer not found after create");
    return transfer;
  }

  private async createTransferInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    data: CreateTransferInput,
  ): Promise<number> {
    {
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
          orgId,
          transferId: created!.id,
          productVariantId: line.productVariantId,
          quantity: line.quantity.toString(),
          lotId: line.lotId ?? null,
          serialId: line.serialId ?? null,
        }))
      );

      return created!.id;
    }
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
    await this.assertCommandEnd(orgId, userId, transferId, "source");

    const transfer = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.transfers.reserve", transferId },
        () => this.reserveTransferInTx(tx, orgId, userId, transferId, idempotencyKey),
        revivedId,
      ),
    );

    // Unscoped for the same reason `createTransfer` is: the source gate above
    // has already settled this caller's standing, and the both-ends predicate
    // would refuse them a transfer they were entitled to reserve.
    return this.loadTransfer(orgId, transfer, null);
  }

  private async reserveTransferInTx(
    tx: Tx, orgId: string, userId: string, transferId: number, idempotencyKey: string,
  ) {
    const [locked] = await tx.execute<{
      id: number; status: string; reference_number: string;
      from_location_id: number; to_location_id: number;
      from_warehouse_id: number | null; to_warehouse_id: number | null; org_id: string;
    }>(sql`
      SELECT id, status, reference_number, from_location_id, to_location_id,
             from_warehouse_id, to_warehouse_id, org_id
      FROM inv_stock_transfers
      WHERE id = ${transferId} AND org_id = ${orgId}
      FOR UPDATE
    `);

    if (!locked) throw new NotFoundException("Transfer not found");
    if (locked.status !== "PENDING") throw new BadRequestException("Only PENDING transfers can be reserved");

    const lines = await tx.query.invStockTransferLines.findMany({
      where: eq(invStockTransferLines.transferId, transferId),
    });

    const reservationIds: number[] = [];
    for (const line of lines) {
      const reservation = await this.reservationService.createReservationInTx(tx, orgId, userId, {
        sourceType: "inv_transfer",
        sourceId: transferId.toString(),
        sourceLineId: line.id.toString(),
        productVariantId: line.productVariantId,
        locationId: locked.from_location_id,
        lotId: line.lotId ?? undefined,
        serialId: line.serialId ?? undefined,
        qty: line.quantity,
      });
      reservationIds.push(reservation.id);
    }

    await tx.update(invStockTransfers)
      .set({ status: "RESERVED", reservedAt: new Date() })
      .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));

    // A5. One event for the reserve, not one per line: reserving a transfer is
    // a single decision about a single document, and a consumer that saw four
    // of five line events would think the transfer was partly held. The
    // reservation ids ride along so a consumer tracking reservations still
    // learns about the ones this command raised.
    await emitInventoryCommandEvent(tx, {
      orgId,
      eventType: INVENTORY_COMMAND_EVENTS.TRANSFER_RESERVED,
      aggregateType: "inv_stock_transfer",
      aggregateId: String(transferId),
      actorUserId: userId,
      payload: {
        transferId,
        referenceNumber: locked.reference_number,
        fromLocationId: Number(locked.from_location_id),
        toLocationId: Number(locked.to_location_id),
        fromWarehouseId: locked.from_warehouse_id === null ? null : Number(locked.from_warehouse_id),
        toWarehouseId: locked.to_warehouse_id === null ? null : Number(locked.to_warehouse_id),
        lineCount: lines.length,
        reservationIds,
        idempotencyKey,
      },
    });

    return transferId;
  }

  // B1-06: engine.executeInTx + reservation consumption + status update in one transaction.
  // invalidateCaches (stock levels + reservations list) called after the outer tx commits.
  //
  // A2. Two movements per line, not one. TRANSFER_OUT empties the source bin and
  // TRANSFER_IN fills the source warehouse's transit location in the same engine
  // command, so org-wide on-hand -- and the valuation that follows it -- is
  // unchanged by a dispatch. Before this the goods were on no stock level at all
  // between dispatch and completion: total on-hand silently dropped for the
  // duration of the journey and nothing told a planner where the units were.
  async dispatchTransfer(orgId: string, userId: string, transferId: number, idempotencyKey: string) {
    /*
     * The movements this posts are already the engine's business — TRANSFER_OUT
     * at the source bin and TRANSFER_IN at the source warehouse's transit
     * location are both inside the source building, so `assertLocationsInScope`
     * would refuse an outsider a moment later and the STOCK was never at risk.
     *
     * What was at risk is everything before that: the header read reports the
     * status of a document the caller may not see, and the transit-location
     * resolve can CREATE a bin in a building they hold nothing in. Refusing here
     * means neither happens, and the refusal is a 404 rather than a status
     * conflict that would describe the document.
     */
    await this.assertCommandEnd(orgId, userId, transferId, "source");

    const transfer = await this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: { lines: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING" && transfer.status !== "RESERVED") {
      throw new BadRequestException("Only PENDING or RESERVED transfers can be dispatched");
    }

    await this.db.transaction(async (tx) => {
      const sourceWarehouseId = await this.sourceWarehouseId(tx, orgId, transfer);
      const transitLocationId = await this.transitLocations.resolve(tx, orgId, sourceWarehouseId);
      const result = await this.engine.executeInTx(tx, orgId, userId, {
        idempotencyKey,
        sourceType: "inv_transfer",
        sourceId: transferId.toString(),
        reason: `Dispatch transfer ${transfer.referenceNumber}`,
        // Paired, and the transit receipt inherits the outbound issue's derived
        // cost by index: the goods enter transit at exactly what leaving the
        // source consumed. An estimate read beforehand — average cost, or the
        // oldest open layer — is exact under weighted average but wrong under
        // FIFO as soon as an issue crosses a layer boundary, and understates
        // inventory for the whole journey.
        movements: transfer.lines.flatMap((line, lineIndex) => [
          {
            transactionType: "TRANSFER_OUT" as const,
            productVariantId: line.productVariantId,
            locationId: transfer.fromLocationId,
            quantityDelta: `-${line.quantity}`,
            lotId: line.lotId ?? undefined,
            serialId: line.serialId ?? undefined,
          },
          {
            transactionType: "TRANSFER_IN" as const,
            productVariantId: line.productVariantId,
            locationId: transitLocationId,
            quantityDelta: line.quantity,
            lotId: line.lotId ?? undefined,
            serialId: line.serialId ?? undefined,
            costFromMovementIndex: lineIndex * 2,
          },
        ]),
      });

      // Carry the cost the source layers were actually consumed at onto the
      // line, so completion can rebuild it at the destination. Cost layers are
      // keyed per location, so without this the stock arrives with no basis.
      await this.stampDispatchedCost(
        tx, orgId, transfer.fromLocationId, transfer.lines, result.transactionIds,
      );

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

        const consumed = await this.reservationService.consumeReservationsBatch(
          tx, orgId, userId, activeReservations,
        );

        // A5. Reservations are only ever consumed as part of a larger command,
        // so the event hangs off the command's idempotency key rather than any
        // one reservation: the set is the fact, and a per-reservation event
        // would be one per row.
        if (consumed.length > 0) {
          await emitInventoryCommandEvent(tx, {
            orgId,
            eventType: INVENTORY_COMMAND_EVENTS.RESERVATION_CONSUMED,
            aggregateType: "inv_stock_reservation",
            aggregateId: idempotencyKey,
            actorUserId: userId,
            payload: {
              reservationIds: consumed,
              sourceType: "inv_transfer",
              sourceId: String(transferId),
              consumedBy: "transfer.dispatch",
            },
          });
        }
      }

      await tx.update(invStockTransfers)
        .set({ status: "IN_TRANSIT", dispatchedAt: new Date() })
        .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));

      // A5. The status guard above refuses anything that is not PENDING or
      // RESERVED, so a replayed dispatch throws before it reaches here and the
      // event lands exactly once per accepted dispatch.
      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.TRANSFER_DISPATCHED,
        aggregateType: "inv_stock_transfer",
        aggregateId: String(transferId),
        actorUserId: userId,
        payload: {
          transferId,
          referenceNumber: transfer.referenceNumber,
          fromLocationId: transfer.fromLocationId,
          toLocationId: transfer.toLocationId,
          fromWarehouseId: sourceWarehouseId,
          toWarehouseId: transfer.toWarehouseId,
          // Where the goods are standing until they arrive. Without it a
          // consumer cannot answer "where is my stock" during the journey.
          transitLocationId,
          lineCount: transfer.lines.length,
          idempotencyKey,
        },
      });
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
   *
   * A2. A dispatch now writes two rows per line, and the second one is a
   * TRANSFER_IN at the transit location whose cost is the estimated basis this
   * service handed the engine, not the cost the source layers were actually
   * consumed at. Matching it instead of the OUT leg would cost the destination
   * from the waypoint's own inbound number and lose the entire point of
   * carrying the cost across, so the read is pinned to the OUT leg twice over:
   * by transaction type and by source location.
   */
  private async stampDispatchedCost(
    tx: Tx,
    orgId: string,
    fromLocationId: number,
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
        eq(invStockTransactions.transactionType, "TRANSFER_OUT"),
        eq(invStockTransactions.locationId, fromLocationId),
      ));

    const costByKey = new Map<string, string>();
    for (const t of txns)
      if (t.unitCost) costByKey.set(`${t.productVariantId}:${t.lotId ?? ""}`, t.unitCost);

    for (const line of lines) {
      const cost = costByKey.get(costKey(line));
      if (!cost) continue;
      await tx.update(invStockTransferLines)
        .set({ dispatchedUnitCost: cost })
        .where(eq(invStockTransferLines.id, line.id));
    }
  }

  /**
   * The warehouse the goods are leaving.
   *
   * `from_warehouse_id` is nullable on the header — a transfer may name only its
   * locations — so the location's own warehouse is the fallback, and the only
   * answer that is always available.
   */
  private async sourceWarehouseId(
    tx: Tx,
    orgId: string,
    transfer: { fromWarehouseId: number | null; fromLocationId: number },
  ): Promise<number> {
    if (transfer.fromWarehouseId !== null) return transfer.fromWarehouseId;
    const [row] = await tx.execute<{ warehouse_id: number }>(sql`
      SELECT warehouse_id FROM inv_locations
      WHERE org_id = ${orgId} AND id = ${transfer.fromLocationId}
      LIMIT 1
    `);
    if (!row) throw new BadRequestException("Transfer source location no longer exists");
    return Number(row.warehouse_id);
  }

  // B1-07: engine.executeInTx + line quantityReceived updates + status update in one transaction.
  // invalidateCaches called after.
  //
  // A2. The mirror of dispatch: TRANSFER_OUT takes the goods off the source
  // warehouse's transit location and TRANSFER_IN puts them in the destination
  // bin, in one command, so on-hand is conserved on arrival exactly as it was on
  // departure.
  //
  // Only what was actually received leaves transit. `quantityReceived` may be
  // less than what was dispatched -- a short receipt is a real event, not an
  // error -- and the shortfall stays standing at the transit location rather
  // than being silently written off. It is on hand, it is not sellable, and it
  // is visible to anyone asking where the missing units went.
  //
  // The transit leg is skipped when the transfer never reached IN_TRANSIT.
  // Completing straight from PENDING or RESERVED posts a destination receipt
  // with no matching issue anywhere -- stock from nowhere -- which is a
  // pre-existing hole in this state machine and not one this change opens or
  // closes; adding a transit issue for goods that were never dispatched would
  // simply fail for want of stock.
  async completeTransfer(orgId: string, userId: string, transferId: number, data: CompleteTransferInput, idempotencyKey: string) {
    /*
     * The DESTINATION end, because completing is a receipt: the goods land in
     * `toLocationId` and the person who answers for that is the keeper there.
     * It is also the end the engine will assert on the arrival movement, so this
     * refuses nothing the engine would have allowed — it simply refuses it
     * before the status is disclosed and before a short receipt can be described
     * back to somebody who cannot see the document.
     */
    await this.assertCommandEnd(orgId, userId, transferId, "destination");

    const transfer = await this.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: { lines: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "IN_TRANSIT" && transfer.status !== "PENDING" && transfer.status !== "RESERVED") {
      throw new BadRequestException("Transfer cannot be completed in its current status");
    }
    const wasDispatched = transfer.status === "IN_TRANSIT";

    await this.db.transaction(async (tx: Tx) => {
      const transitLocationId = wasDispatched
        ? await this.transitLocations.resolve(
            tx, orgId, await this.sourceWarehouseId(tx, orgId, transfer),
          )
        : null;

      const movements = data.lines.flatMap((completion) => {
        const line = transfer.lines.find((l) => l.id === completion.transferLineId);
        if (!line || completion.quantityReceived <= 0) return [];
        const received = completion.quantityReceived.toFixed(4);
        const arrival = {
          transactionType: "TRANSFER_IN" as const,
          productVariantId: line.productVariantId,
          locationId: transfer.toLocationId,
          quantityDelta: received,
          lotId: line.lotId ?? undefined,
          serialId: line.serialId ?? undefined,
          unitCost: line.dispatchedUnitCost ?? undefined,
        };
        if (transitLocationId === null) return [arrival];
        return [
          {
            transactionType: "TRANSFER_OUT" as const,
            productVariantId: line.productVariantId,
            locationId: transitLocationId,
            quantityDelta: `-${received}`,
            lotId: line.lotId ?? undefined,
            serialId: line.serialId ?? undefined,
          },
          arrival,
        ];
      });

      await this.engine.executeInTx(tx, orgId, userId, {
        idempotencyKey,
        sourceType: "inv_transfer",
        sourceId: transferId.toString(),
        reason: `Complete transfer ${transfer.referenceNumber}`,
        movements,
      });

      let receivedLineCount = 0;
      for (const completion of data.lines) {
        const line = transfer.lines.find((l) => l.id === completion.transferLineId);
        if (!line) continue;
        receivedLineCount += 1;
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

      // A5. As with dispatch, the status guard makes this once-per-acceptance:
      // a completed transfer can no longer be completed.
      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.TRANSFER_COMPLETED,
        aggregateType: "inv_stock_transfer",
        aggregateId: String(transferId),
        actorUserId: userId,
        payload: {
          transferId,
          referenceNumber: transfer.referenceNumber,
          fromLocationId: transfer.fromLocationId,
          toLocationId: transfer.toLocationId,
          fromWarehouseId: transfer.fromWarehouseId,
          toWarehouseId: transfer.toWarehouseId,
          lineCount: transfer.lines.length,
          receivedLineCount,
          // A completion that never went through transit is a different event
          // in substance — nothing was ever dispatched — and a consumer
          // reconciling against a dispatch needs to know which it is holding.
          wasDispatched,
          idempotencyKey,
        },
      });
    });

    await this.engine.invalidateCaches(orgId);
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
    await this.assertCommandEnd(orgId, userId, transferId, "source");

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
          return this.cancelTransferInTx(tx, orgId, userId, transferId, current.status);
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

  private async cancelTransferInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    transferId: number,
    status: string,
  ): Promise<{ cancelled: number }> {
    if (status === "RESERVED") {
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

    return { cancelled: transferId };
  }
}
