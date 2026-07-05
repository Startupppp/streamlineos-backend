import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  invLoads,
  invLoadLines,
  invShipments,
  invStockTransfers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { NumberSequenceService } from "../inv-stock-engine/number-sequence.service";
import { InventoryAuditService } from "../inv-stock-engine/inventory-audit.service";
import type { ListLoadsQueryInput, CreateLoadInput, DispatchLoadInput, CloseLoadInput } from "./dto/shipments.schemas";

@Injectable()
export class LoadsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
  ) {}

  async list(orgId: string, query: ListLoadsQueryInput) {
    const { status, carrierId, page, limit } = query;
    const offset = (page - 1) * limit;
    const hash = `${status ?? ""}:${carrierId ?? ""}:${limit}:${offset}`;

    return this.cache.cached(CACHE_KEYS.invLoadsList(orgId, hash), async () => {
      const conditions = [eq(invLoads.orgId, orgId)];
      if (status) conditions.push(eq(invLoads.status, status));
      if (carrierId) conditions.push(eq(invLoads.carrierId, carrierId));
      const where = and(...conditions);

      const [items, [countRow]] = await Promise.all([
        this.db.select().from(invLoads).where(where).orderBy(desc(invLoads.createdAt)).limit(limit).offset(offset),
        this.db.select({ total: sql<number>`count(*)::int` }).from(invLoads).where(where),
      ]);
      const total = countRow?.total ?? 0;
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  async findOne(orgId: string, loadId: number) {
    return this.cache.cached(CACHE_KEYS.invLoadDetail(orgId, loadId), async () => {
      const [load] = await this.db.select().from(invLoads).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId))).limit(1);
      if (!load) throw new NotFoundException("Load not found");
      const lines = await this.db.select().from(invLoadLines).where(eq(invLoadLines.loadId, loadId));
      return { ...load, lines };
    }, CACHE_TTL.MEDIUM);
  }

  async create(orgId: string, userId: string, input: CreateLoadInput) {
    const loadNumber = await this.numSeq.next(orgId, "LOAD");
    const load = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(invLoads).values({
        orgId,
        loadNumber,
        sourceWarehouseId: input.sourceWarehouseId ?? null,
        destination: input.destination ?? null,
        carrierId: input.carrierId ?? null,
        vehicleRef: input.vehicleRef ?? null,
        createdBy: userId,
      }).returning();

      const lineValues: Array<{ loadId: number; shipmentId: number | null; transferId: number | null }> = [];
      for (const sid of input.shipmentIds ?? []) {
        lineValues.push({ loadId: row!.id, shipmentId: sid, transferId: null });
      }
      for (const tid of input.transferIds ?? []) {
        lineValues.push({ loadId: row!.id, shipmentId: null, transferId: tid });
      }
      if (lineValues.length > 0) {
        await tx.insert(invLoadLines).values(lineValues);
      }

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "load.created",
        resourceType: "load",
        resourceId: String(row!.id),
      });
      return row!;
    });
    await this.cache.invalidatePattern(`inv:loads:list:${orgId}:*`);
    return load;
  }

  async dispatch(orgId: string, userId: string, loadId: number, input: DispatchLoadInput) {
    const [load] = await this.db.select().from(invLoads).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId))).limit(1);
    if (!load) throw new NotFoundException("Load not found");
    if (load.status !== "DRAFT") throw new ConflictException("Load must be DRAFT to dispatch");

    const lines = await this.db.select().from(invLoadLines).where(eq(invLoadLines.loadId, loadId));

    for (const line of lines) {
      if (line.shipmentId != null) {
        const [shipment] = await this.db.select().from(invShipments).where(eq(invShipments.id, line.shipmentId)).limit(1);
        if (shipment && shipment.status !== "SHIPPED") {
          throw new BadRequestException("All shipments must be SHIPPED before dispatching");
        }
      }
      if (line.transferId != null) {
        const [transfer] = await this.db.select().from(invStockTransfers).where(eq(invStockTransfers.id, line.transferId)).limit(1);
        if (transfer && transfer.status !== "IN_TRANSIT") {
          throw new BadRequestException("All transfers must be IN_TRANSIT before dispatching");
        }
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx.update(invLoads).set({
        status: "DISPATCHED",
        dispatchDate: input.dispatchDate ?? today,
        updatedAt: new Date(),
      }).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId))).returning();
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "load.dispatched",
        resourceType: "load",
        resourceId: String(loadId),
      });
      return rows;
    });
    await this.cache.invalidate(CACHE_KEYS.invLoadDetail(orgId, loadId));
    await this.cache.invalidatePattern(`inv:loads:list:${orgId}:*`);
    return updated;
  }

  async close(orgId: string, userId: string, loadId: number, input: CloseLoadInput) {
    const [load] = await this.db.select().from(invLoads).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId))).limit(1);
    if (!load) throw new NotFoundException("Load not found");
    if (load.status !== "DISPATCHED" && load.status !== "ARRIVED") {
      throw new ConflictException("Load must be DISPATCHED or ARRIVED to close");
    }

    const today = new Date().toISOString().slice(0, 10);
    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx.update(invLoads).set({
        status: "CLOSED",
        arrivalDate: input.arrivalDate ?? today,
        updatedAt: new Date(),
      }).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId))).returning();
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "load.closed",
        resourceType: "load",
        resourceId: String(loadId),
      });
      return rows;
    });
    await this.cache.invalidate(CACHE_KEYS.invLoadDetail(orgId, loadId));
    await this.cache.invalidatePattern(`inv:loads:list:${orgId}:*`);
    return updated;
  }

  async cancel(orgId: string, userId: string, loadId: number) {
    const [load] = await this.db.select().from(invLoads).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId))).limit(1);
    if (!load) throw new NotFoundException("Load not found");
    if (load.status !== "DRAFT") throw new ConflictException("Load must be DRAFT to cancel");

    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx.update(invLoads).set({
        status: "CANCELLED",
        cancelledAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId))).returning();
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "load.cancelled",
        resourceType: "load",
        resourceId: String(loadId),
      });
      return rows;
    });
    await this.cache.invalidate(CACHE_KEYS.invLoadDetail(orgId, loadId));
    await this.cache.invalidatePattern(`inv:loads:list:${orgId}:*`);
    return updated;
  }
}
