import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  invShipments,
  invShipmentLines,
  invPackages,
  invSalesOrders,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import type {
  ListShipmentsQueryInput,
  CreateShipmentInput,
  UpdateShipmentInput,
  ShipActionInput,
} from "./dto/shipments.schemas";

@Injectable()
export class ShipmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
    private readonly settings: InventorySettingsService,
  ) {}

  async list(orgId: string, query: ListShipmentsQueryInput) {
    const { status, carrierId, warehouseId, soId, page, limit } = query;
    const offset = (page - 1) * limit;
    const hash = `${status ?? ""}:${carrierId ?? ""}:${warehouseId ?? ""}:${soId ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invShipmentsNamespace(orgId), `list:${hash}`, async () => {
      const conditions = [eq(invShipments.orgId, orgId)];
      if (status) conditions.push(eq(invShipments.status, status));
      if (carrierId) conditions.push(eq(invShipments.carrierId, carrierId));
      if (warehouseId) conditions.push(eq(invShipments.warehouseId, warehouseId));
      if (soId) conditions.push(eq(invShipments.soId, soId));
      const where = and(...conditions);

      const [items, [countRow]] = await Promise.all([
        this.db.select().from(invShipments).where(where).orderBy(desc(invShipments.createdAt)).limit(limit).offset(offset),
        this.db.select({ total: sql<number>`count(*)::int` }).from(invShipments).where(where),
      ]);
      const total = countRow?.total ?? 0;
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  async findOne(orgId: string, shipmentId: number) {
    return this.cache.cachedVersioned(CACHE_KEYS.invShipmentsNamespace(orgId), `detail:${shipmentId}`, async () => {
      const [shipment] = await this.db.select().from(invShipments).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId))).limit(1);
      if (!shipment) throw new NotFoundException("Shipment not found");
      const [lines, packages] = await Promise.all([
        this.db.select().from(invShipmentLines).where(eq(invShipmentLines.shipmentId, shipmentId)),
        this.db.select().from(invPackages).where(and(eq(invPackages.shipmentId, shipmentId), eq(invPackages.orgId, orgId))),
      ]);
      return { ...shipment, lines, packages };
    }, CACHE_TTL.MEDIUM);
  }

  async create(orgId: string, userId: string, input: CreateShipmentInput) {
    const shipmentNumber = await this.numSeq.next(orgId, "SHIPMENT");
    const shipment = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(invShipments).values({
        orgId,
        shipmentNumber,
        soId: input.soId ?? null,
        warehouseId: input.warehouseId ?? null,
        carrierId: input.carrierId ?? null,
        trackingNumber: input.trackingNumber ?? null,
        createdBy: userId,
      }).returning();
      if (input.lines && input.lines.length > 0) {
        await tx.insert(invShipmentLines).values(
          input.lines.map((l) => ({
            shipmentId: row!.id,
            soLineId: l.soLineId ?? null,
            productVariantId: l.productVariantId,
            quantity: l.quantity,
            lotId: l.lotId ?? null,
            serialId: l.serialId ?? null,
          })),
        );
      }
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "shipment.created",
        resourceType: "shipment",
        resourceId: String(row!.id),
      });
      return row!;
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invShipmentsNamespace(orgId));
    return shipment;
  }

  async update(orgId: string, userId: string, shipmentId: number, input: UpdateShipmentInput) {
    const [shipment] = await this.db.select().from(invShipments).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId))).limit(1);
    if (!shipment) throw new NotFoundException("Shipment not found");
    if (shipment.status !== "DRAFT" && shipment.status !== "PACKED") {
      throw new ConflictException("Shipment cannot be updated in its current status");
    }
    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx.update(invShipments).set({ ...input, updatedAt: new Date() }).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId))).returning();
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "shipment.updated",
        resourceType: "shipment",
        resourceId: String(shipmentId),
        before: shipment,
        after: rows[0],
      });
      return rows;
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invShipmentsNamespace(orgId));
    return updated;
  }

  async ship(orgId: string, userId: string, shipmentId: number, input: ShipActionInput, idempotencyKey: string) {
    const [shipment] = await this.db.select().from(invShipments).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId))).limit(1);
    if (!shipment) throw new NotFoundException("Shipment not found");

    if (shipment.status === "SHIPPED") return shipment;
    if (shipment.status === "CANCELLED") throw new ConflictException("Shipment is cancelled");

    if (shipment.soId != null) {
      const [so] = await this.db.select().from(invSalesOrders).where(and(eq(invSalesOrders.id, shipment.soId), eq(invSalesOrders.orgId, orgId))).limit(1);
      if (so && so.status !== "SHIPPED") {
        throw new ConflictException("Ship via sales order first");
      }
    }

    const cfg = await this.settings.get(orgId);
    if (cfg.packageRequiredForShipping) {
      const [pkgCount] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invPackages)
        .where(and(eq(invPackages.shipmentId, shipmentId), eq(invPackages.orgId, orgId), eq(invPackages.status, "CLOSED")));
      if ((pkgCount?.count ?? 0) === 0) {
        throw new BadRequestException("At least one closed package required");
      }
    }

    const safeInput = input ?? {};
    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx.update(invShipments).set({
        status: "SHIPPED",
        shippedAt: new Date(),
        trackingNumber: safeInput.trackingNumber ?? shipment.trackingNumber,
        carrierId: safeInput.carrierId ?? shipment.carrierId,
        updatedAt: new Date(),
      }).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId))).returning();
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "shipment.shipped",
        resourceType: "shipment",
        resourceId: String(shipmentId),
        metadata: { idempotencyKey },
      });
      return rows;
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invShipmentsNamespace(orgId));
    return updated;
  }

  async cancel(orgId: string, userId: string, shipmentId: number) {
    const [shipment] = await this.db.select().from(invShipments).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId))).limit(1);
    if (!shipment) throw new NotFoundException("Shipment not found");
    if (shipment.status === "SHIPPED") throw new ConflictException("Cannot cancel shipped shipment");

    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx.update(invShipments).set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() }).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId))).returning();
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "shipment.cancelled",
        resourceType: "shipment",
        resourceId: String(shipmentId),
      });
      return rows;
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invShipmentsNamespace(orgId));
    return updated;
  }
}
