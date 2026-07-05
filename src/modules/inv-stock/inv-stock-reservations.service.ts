import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invStockReservations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { ReservationService } from "../inv-stock-engine/reservation.service";
import { StockEngineService } from "../inv-stock-engine/stock-engine.service";
import type { ListReservationsInput, CreateReservationInput, ReleaseReservationInput, OpeningStockInput } from "./dto/inv-stock.schemas";

@Injectable()
export class InvStockReservationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly reservationService: ReservationService,
    private readonly engine: StockEngineService,
  ) {}

  async listReservations(orgId: string, filters: ListReservationsInput) {
    const { sourceType, status, variantId, warehouseId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${sourceType ?? ""}:${status ?? ""}:${variantId ?? ""}:${warehouseId ?? ""}:${limit}:${offset}`;

    return this.cache.cached(CACHE_KEYS.invReservationsList(orgId, hash), async () => {
      const conditions = [eq(invStockReservations.orgId, orgId)];
      if (sourceType) conditions.push(eq(invStockReservations.sourceType, sourceType));
      if (status) conditions.push(eq(invStockReservations.status, status));
      if (variantId) conditions.push(eq(invStockReservations.productVariantId, variantId));
      if (warehouseId) conditions.push(eq(invStockReservations.warehouseId, warehouseId) as ReturnType<typeof eq>);

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

  async createReservation(orgId: string, userId: string, input: CreateReservationInput, idempotencyKey: string) {
    const reservation = await this.reservationService.createReservation(orgId, userId, {
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
    await this.cache.invalidatePattern(CACHE_KEYS.invReservationsList(orgId, "*") + "");
    return reservation;
  }

  async releaseReservation(orgId: string, userId: string, input: ReleaseReservationInput) {
    await this.reservationService.releaseReservation(orgId, userId, input.reservationId);
    await this.cache.invalidatePattern(CACHE_KEYS.invReservationsList(orgId, "*") + "");
  }

  async createOpeningBalance(orgId: string, userId: string, input: OpeningStockInput, idempotencyKey: string) {
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
