import { Inject, Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  invCustomerReturns, invCustomerReturnLines, invSerialNumbers,
  invLocations, invSalesOrders, invShipments,
} from "../../../db/schema";
import { clientPartyMap } from "../../../db/schema/party";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import type { ListReturnsInput, CreateCustomerReturnInput, PostCustomerReturnInput } from "./dto/inv-returns.schemas";

@Injectable()
export class CustomerReturnsService {
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

    return this.cache.cachedVersioned(CACHE_KEYS.invCustomerReturnsNamespace(orgId), hash, async () => {
      // A return carries no warehouse of its own. It is attributable through
      // whichever source document it came back against — the order or the
      // shipment — and a return with neither belongs to no warehouse.
      const conditions = [
        eq(invCustomerReturns.orgId, orgId),
        scope.anyOf(
          sql`${invCustomerReturns.soId} IN (SELECT id FROM inv_sales_orders WHERE org_id = ${orgId} AND ${scope.warehouse(sql.raw("warehouse_id"))})`,
          sql`${invCustomerReturns.shipmentId} IN (SELECT id FROM inv_shipments WHERE org_id = ${orgId} AND ${scope.warehouse(sql.raw("warehouse_id"))})`,
        ),
      ];
      if (status) conditions.push(eq(invCustomerReturns.status, status));
      const where = and(...conditions);

      const [items, countResult] = await Promise.all([
        this.db.query.invCustomerReturns.findMany({
          where,
          orderBy: [desc(invCustomerReturns.createdAt)],
          limit,
          offset,
          with: {
            creator: { columns: { id: true, name: true } },
            lines: true,
          },
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invCustomerReturns).where(where),
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
    const ret = await this.db.query.invCustomerReturns.findFirst({
      where: and(eq(invCustomerReturns.id, returnId), eq(invCustomerReturns.orgId, orgId)),
      with: {
        creator: { columns: { id: true, name: true } },
        approver: { columns: { id: true, name: true } },
        lines: true,
      },
    });
    if (!ret) throw new NotFoundException("Customer return not found");
    return ret;
  }

  async create(orgId: string, userId: string, data: CreateCustomerReturnInput) {
    if (data.soId !== undefined && data.soId !== null) {
      const so = await this.db.query.invSalesOrders.findFirst({
        where: and(eq(invSalesOrders.id, data.soId), eq(invSalesOrders.orgId, orgId)),
        columns: { id: true },
      });
      if (!so) throw new BadRequestException("Sales order not found in this organization");
    }

    if (data.shipmentId !== undefined && data.shipmentId !== null) {
      const shipment = await this.db.query.invShipments.findFirst({
        where: and(eq(invShipments.id, data.shipmentId), eq(invShipments.orgId, orgId)),
        columns: { id: true },
      });
      if (!shipment) throw new BadRequestException("Shipment not found in this organization");
    }

    if (data.clientId !== undefined && data.clientId !== null) {
      /*
       * Asked of `client_party_map` rather than `clients`, which answers the same
       * question through the Party seam. The map's primary key is
       * `(organization_id, client_id)` and its composite foreign key cascades from
       * `clients`, so a row exists here exactly when the client exists in this
       * tenant -- which is all this check ever wanted. `invCustomerReturns.client_id`
       * still points at `clients`, so the id kept here is still the legacy one.
       */
      const [client] = await this.db
        .select({ id: clientPartyMap.clientId })
        .from(clientPartyMap)
        .where(
          and(
            eq(clientPartyMap.clientId, data.clientId),
            eq(clientPartyMap.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!client) throw new BadRequestException("Client not found in this organization");
    }

    const returnNumber = await this.numSeq.next(orgId, "CUSTOMER_RETURN");

    const [ret] = await this.db.insert(invCustomerReturns).values({
      orgId,
      returnNumber,
      soId: data.soId,
      shipmentId: data.shipmentId,
      clientId: data.clientId,
      notes: data.notes,
      status: "DRAFT",
      createdBy: userId,
    }).returning();

    await this.db.insert(invCustomerReturnLines).values(
      data.lines.map((line) => ({
        orgId,
        returnId: ret.id,
        productVariantId: line.productVariantId,
        lotId: line.lotId,
        serialId: line.serialId,
        quantity: line.quantity.toFixed(4),
        disposition: line.disposition,
        notes: line.reason,
      }))
    );

    await this.cache.invalidateNamespace(CACHE_KEYS.invCustomerReturnsNamespace(orgId));
    return this.get(orgId, ret.id);
  }

  async post(
    orgId: string,
    returnId: number,
    userId: string,
    idempotencyKey: string,
    data: PostCustomerReturnInput,
  ) {
    const ret = await this.db.query.invCustomerReturns.findFirst({
      where: and(eq(invCustomerReturns.id, returnId), eq(invCustomerReturns.orgId, orgId)),
      with: { lines: true },
    });
    if (!ret) throw new NotFoundException("Customer return not found");
    if (ret.status === "POSTED") return this.get(orgId, returnId);
    if (ret.status !== "DRAFT") throw new BadRequestException("Only DRAFT customer returns can be posted");

    const engineMovements: Array<{
      transactionType: string;
      productVariantId: number;
      locationId: number;
      lotId?: number;
      serialId?: number;
      quantityDelta: string;
      qualityBucket?: "ON_HAND" | "BLOCKED" | "QUALITY_HOLD";
    }> = [];

    for (const line of ret.lines) {
      const disposition = line.disposition;
      if (disposition === "SCRAP") continue;

      const targetLocationId = await this.resolveTargetLocation(orgId, line);

      if (disposition === "RESTOCK") {
        engineMovements.push({
          transactionType: "CUSTOMER_RETURN",
          productVariantId: line.productVariantId,
          locationId: targetLocationId,
          lotId: line.lotId ?? undefined,
          serialId: line.serialId ?? undefined,
          quantityDelta: line.quantity,
          qualityBucket: "ON_HAND",
        });
      } else if (disposition === "QUARANTINE") {
        engineMovements.push({
          transactionType: "QUARANTINE_IN",
          productVariantId: line.productVariantId,
          locationId: targetLocationId,
          lotId: line.lotId ?? undefined,
          serialId: line.serialId ?? undefined,
          quantityDelta: line.quantity,
          qualityBucket: "QUALITY_HOLD",
        });
      }
    }

    const serialLines = ret.lines.filter(
      (l): l is typeof l & { serialId: number } => l.serialId !== null
    );

    type SerialStatus = "IN_STOCK" | "SCRAPPED" | "QUARANTINE";
    const byStatus = new Map<SerialStatus, number[]>();
    for (const line of serialLines) {
      const serialStatus: SerialStatus =
        line.disposition === "RESTOCK" ? "IN_STOCK" :
        line.disposition === "SCRAP" ? "SCRAPPED" : "QUARANTINE";
      const ids = byStatus.get(serialStatus) ?? [];
      ids.push(line.serialId);
      byStatus.set(serialStatus, ids);
    }

    await this.db.transaction(async (tx) => {
      if (engineMovements.length > 0) {
        await this.engine.executeInTx(tx, orgId, userId, {
          idempotencyKey,
          sourceType: "inv_customer_return",
          sourceId: String(returnId),
          reason: data.reason,
          movements: engineMovements,
        });
      }

      for (const [serialStatus, ids] of byStatus) {
        await tx.update(invSerialNumbers)
          .set({ status: serialStatus })
          .where(inArray(invSerialNumbers.id, ids));
      }

      await tx.update(invCustomerReturns)
        .set({ status: "POSTED", postedAt: new Date(), approvedBy: userId, updatedAt: new Date() })
        .where(and(eq(invCustomerReturns.id, returnId), eq(invCustomerReturns.orgId, orgId), eq(invCustomerReturns.status, "DRAFT")));
    });

    await this.engine.invalidateCaches(orgId);
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.invCustomerReturnsNamespace(orgId)),
      this.cache.del(CACHE_KEYS.invCustomerReturnDetail(orgId, returnId)),
    ]);
    return this.get(orgId, returnId);
  }

  private async resolveTargetLocation(
    orgId: string,
    line: typeof invCustomerReturnLines.$inferSelect & { targetLocationId?: number },
  ): Promise<number> {
    if (line.targetLocationId) {
      return line.targetLocationId;
    }

    type LocationType = typeof invLocations.$inferSelect["locationType"];
    const locationType: LocationType = line.disposition === "QUARANTINE" ? "QUARANTINE" : "RETURNS";
    const loc = await this.db.query.invLocations.findFirst({
      where: and(
        eq(invLocations.orgId, orgId),
        eq(invLocations.locationType, locationType),
        eq(invLocations.isActive, true),
      ),
      columns: { id: true },
    });

    if (loc) return loc.id;

    const anyLoc = await this.db.query.invLocations.findFirst({
      where: and(eq(invLocations.orgId, orgId), eq(invLocations.isActive, true)),
      columns: { id: true },
      orderBy: (t, { asc }) => [asc(t.id)],
    });

    if (!anyLoc) throw new BadRequestException("No active location found for customer return");
    return anyLoc.id;
  }

  async cancel(orgId: string, returnId: number) {
    const ret = await this.db.query.invCustomerReturns.findFirst({
      where: and(eq(invCustomerReturns.id, returnId), eq(invCustomerReturns.orgId, orgId)),
    });
    if (!ret) throw new NotFoundException("Customer return not found");
    if (ret.status !== "DRAFT") throw new BadRequestException("Only DRAFT customer returns can be cancelled");

    await this.db.update(invCustomerReturns)
      .set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invCustomerReturns.id, returnId), eq(invCustomerReturns.orgId, orgId)));

    await this.cache.invalidateNamespace(CACHE_KEYS.invCustomerReturnsNamespace(orgId));
    return this.get(orgId, returnId);
  }
}
