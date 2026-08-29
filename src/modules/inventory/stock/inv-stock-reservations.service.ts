import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { invStockReservations } from "../../../db/schema";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { ReservationService } from "../stock-engine/reservation.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import type { ListReservationsInput, CreateReservationInput, ReleaseReservationInput, OpeningStockInput } from "./dto/inv-stock.schemas";
import { loadOrderableVariants, loadCorrectableVariants } from "../products/lib/orderable-variants";

@Injectable()
export class InvStockReservationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly reservationService: ReservationService,
    private readonly engine: StockEngineService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async listReservations(orgId: string, userId: string, filters: ListReservationsInput) {
    const { sourceType, status, variantId, warehouseId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${sourceType ?? ""}:${status ?? ""}:${variantId ?? ""}:${warehouseId ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(`inv:reservations:list:${orgId}`, hash, async () => {
      const conditions: SQL[] = [
        eq(invStockReservations.orgId, orgId),
        // Both columns are nullable, so a reservation may be attributed by
        // either. A row attributed by neither names no warehouse at all and
        // stays invisible to a warehouse-scoped caller.
        scope.anyOf(
          scope.warehouse(sql`${invStockReservations.warehouseId}`),
          scope.location(sql`${invStockReservations.locationId}`),
        ),
      ];
      if (sourceType) conditions.push(eq(invStockReservations.sourceType, sourceType));
      if (status) conditions.push(eq(invStockReservations.status, status));
      if (variantId) conditions.push(eq(invStockReservations.productVariantId, variantId));
      if (warehouseId) conditions.push(eq(invStockReservations.warehouseId, warehouseId));

      const where = and(...conditions);
      const [items, countResult] = await Promise.all([
        this.db.query.invStockReservations.findMany({
          where,
          limit,
          offset,
          with: {
            productVariant: { columns: { id: true, sku: true, name: true } },
            location: { columns: { id: true, name: true, code: true } },
            warehouse: { columns: { id: true, name: true } },
          },
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invStockReservations).where(where),
      ]);

      const total = countResult[0]?.count ?? 0;
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  /**
   * A3. Reserving is the command that most needed a key and had none.
   *
   * The route demanded an `Idempotency-Key` header, threw without it, and then
   * called this method without it — so the client was made to supply a key that
   * changed nothing. A retried reserve inserted a *second* ACTIVE reservation
   * and incremented `committed` again, holding the same stock twice against one
   * order, which availability then subtracted twice.
   *
   * The claim is taken in the same transaction as the insert. A claim committed
   * separately from the work it guards protects nothing: the claim can survive
   * while the work rolls back, and the retry replays a reservation that does not
   * exist.
   *
   * The reservation is read back by id rather than revived from the stored JSON.
   * A stored response has been through the database, so its timestamps come back
   * as strings; re-reading returns a real row on the replay path and the first
   * one, and it is the same row either way.
   */
  async createReservation(
    orgId: string,
    userId: string,
    input: CreateReservationInput,
    idempotencyKey: string,
  ) {
    // A4. A reservation raised by hand is new demand and takes the demand gate.
    // Reservations created *for an existing document* go through
    // `createReservationInTx` and are deliberately not gated — discontinuing a
    // product must not strand an order already taken.
    await loadOrderableVariants(this.db, orgId, [input.productVariantId]);

    const reservationId = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.stock.reserve", input },
        async () => {
          const created = await this.reservationService.createReservationInTx(tx, orgId, userId, {
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            sourceLineId: input.sourceLineId,
            productVariantId: input.productVariantId,
            warehouseId: input.warehouseId,
            locationId: input.locationId,
            lotId: input.lotId,
            serialId: input.serialId,
            qty: input.qty,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
          });
          return created.id;
        },
        revivedId,
      ),
    );

    await this.cache.invalidateNamespace(`inv:reservations:list:${orgId}`);
    const reservation = await this.db.query.invStockReservations.findFirst({
      where: and(
        eq(invStockReservations.orgId, orgId),
        eq(invStockReservations.id, reservationId),
      ),
    });
    if (!reservation) throw new NotFoundException("Reservation not found");
    return reservation;
  }

  /**
   * Releasing is already idempotent underneath — `releaseReservationInTx` takes
   * the row `FOR UPDATE` and returns without doing anything when it is not
   * ACTIVE, so a double release cannot decrement `committed` twice.
   *
   * It still claims a key, because the contract a client sees should not depend
   * on which stock commands happen to be safe to repeat: every stock-affecting
   * POST takes a key and means the same thing by it. Here the claim is belt and
   * braces rather than the mechanism.
   */
  async releaseReservation(
    orgId: string,
    userId: string,
    input: ReleaseReservationInput,
    idempotencyKey: string,
  ) {
    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.stock.release-reservation", input },
        async () => {
          await this.reservationService.releaseReservationInTx(
            tx, orgId, userId, input.reservationId,
          );
          return { released: input.reservationId };
        },
        () => ({ released: input.reservationId }),
      ),
    );
    await this.cache.invalidateNamespace(`inv:reservations:list:${orgId}`);
  }

  async createOpeningBalance(orgId: string, userId: string, input: OpeningStockInput, idempotencyKey: string) {
    // Opening stock states what is already on the shelf, so it takes the
    // correction gate rather than the demand one.
    await loadCorrectableVariants(this.db, orgId, input.lines.map((l) => l.productVariantId));

    return this.engine.execute(orgId, userId, {
      idempotencyKey,
      sourceType: "opening_balance",
      sourceId: `ob:${orgId}:${idempotencyKey}`,
      reason: input.notes,
      movements: input.lines.map((line) => ({
        transactionType: "OPENING_BALANCE",
        productVariantId: line.productVariantId,
        locationId: line.locationId,
        quantityDelta: line.qty.toFixed(4),
        unitCost: line.unitCost !== undefined ? line.unitCost.toFixed(4) : undefined,
      })),
    });
  }
}
