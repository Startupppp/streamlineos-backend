import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";
import { and, eq, desc, sql, type SQL } from "drizzle-orm";
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
import { WarehouseScopeService, type ResolvedWarehouseScope } from "../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { randomUUID } from "node:crypto";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { runIdempotent } from "../stock-engine/idempotency";
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
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * Which shipments this caller may see — the list's rule, now the only copy.
   *
   * A shipment names its warehouse directly, so the rule is the plain column
   * predicate. The NULL half of it is worth stating because it differs by table
   * on purpose: `NULL IN (…)` is NULL, so a shipment attributed to no warehouse
   * is INVISIBLE to a scoped operator, exactly as it already was in the list.
   * That is the opposite of the ASN header, which keeps an `IS NULL` escape
   * because its warehouse may genuinely not be known yet. Each detail follows
   * its own aggregate, and this one follows the list above it.
   *
   * Private and single so the detail reads cannot drift from the list: two
   * hand-copied predicates agreeing today is not the same as them being one.
   */
  private shipmentInScope(scope: ResolvedWarehouseScope): SQL {
    return scope.warehouse(sql`${invShipments.warehouseId}`);
  }

  async list(orgId: string, userId: string, query: ListShipmentsQueryInput) {
    const { status, carrierId, warehouseId, soId, from, to, page, limit } = query;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    // Every filter that changes the result changes the key. A window omitted
    // here would serve one date range's page under another's.
    const hash = `${scope.key}:${status ?? ""}:${carrierId ?? ""}:${warehouseId ?? ""}:${soId ?? ""}:${from ?? ""}:${to ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invShipmentsNamespace(orgId), `list:${hash}`, async () => {
      const conditions = [eq(invShipments.orgId, orgId), this.shipmentInScope(scope)];
      if (status) conditions.push(eq(invShipments.status, status));
      if (carrierId) conditions.push(eq(invShipments.carrierId, carrierId));
      if (warehouseId) conditions.push(eq(invShipments.warehouseId, warehouseId));
      if (soId) conditions.push(eq(invShipments.soId, soId));
      // Half-open at the top so the whole of `to` is included — the same
      // convention the throughput report measures its window by, so a
      // drill-through lands on the rows the report counted.
      if (from) conditions.push(sql`${invShipments.shippedAt} >= ${from}::date`);
      if (to) conditions.push(sql`${invShipments.shippedAt} < (${to}::date + 1)`);
      const where = and(...conditions);

      const [items, [countRow]] = await Promise.all([
        this.db.select().from(invShipments).where(where).orderBy(desc(invShipments.createdAt)).limit(limit).offset(offset),
        this.db.select({ total: sql<number>`count(*)::int` }).from(invShipments).where(where),
      ]);
      const total = countRow?.total ?? 0;
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  /**
   * One shipment, read by id — and, until now, by anyone in the org.
   *
   * `list` beside it resolved the caller's warehouses; this took no `userId` at
   * all, because the controller never passed one, so a shipment an operator
   * could not see in their list was theirs to read whole: the lines, the
   * packages, the tracking number and the carrier.
   *
   * The scope discriminator in the cache key is not decoration. Adding the
   * predicate below while leaving the key as `detail:<id>` would make this WORSE
   * than the unscoped read it replaces — one caller's narrowed answer stored
   * under a scope-free key and served to the next, defeating the filter in both
   * directions (§6).
   */
  async findOne(orgId: string, userId: string, shipmentId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.cache.cachedVersioned(CACHE_KEYS.invShipmentsNamespace(orgId), `detail:${scope.key}:${shipmentId}`, async () => {
      const [shipment] = await this.db.select().from(invShipments).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId), this.shipmentInScope(scope))).limit(1);
      // 404 rather than 403: a "forbidden" on an id the caller may not see
      // confirms the shipment exists, which is the existence oracle §4 bars.
      if (!shipment) throw new NotFoundException("Shipment not found");
      const [lines, packages] = await Promise.all([
        this.db.select().from(invShipmentLines).where(eq(invShipmentLines.shipmentId, shipmentId)),
        this.db.select().from(invPackages).where(and(eq(invPackages.shipmentId, shipmentId), eq(invPackages.orgId, orgId))),
      ]);
      return { ...shipment, lines, packages };
    }, CACHE_TTL.MEDIUM);
  }

  async create(orgId: string, userId: string, input: CreateShipmentInput) {
    /*
     * A shipment ships OUT of a warehouse, so the same rule as a transfer's
     * source: only out of a building you hold. `warehouseId` came straight off
     * the request body and was written unchecked, and nothing downstream catches
     * it — creating a shipment posts no movements, so the stock engine's
     * `assertLocationsInScope` never runs on this path.
     *
     * Only asserted when one is given: the column is nullable and a shipment
     * with no warehouse yet is a legitimate draft, not an attempt at somebody
     * else's building. 404 rather than 403, so naming a warehouse you cannot see
     * does not confirm it exists.
     */
    if (input.warehouseId != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);
    }

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
            orgId,
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
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [shipment] = await this.db.select().from(invShipments).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId), this.shipmentInScope(scope))).limit(1);
    if (!shipment) throw new NotFoundException("Shipment not found");
    if (shipment.status !== "DRAFT" && shipment.status !== "PACKED") {
      throw new ConflictException("Shipment cannot be updated in its current status");
    }

    /*
     * BOTH ends, because `updateShipmentSchema` carries `warehouseId`.
     *
     * Gating the read alone would leave the create-side assert bypassable: name
     * a shipment you CAN see, then PATCH its `warehouseId` into a building you
     * cannot, and the header is re-homed into somebody else's warehouse without
     * the create path ever being asked. The destination is asserted with the
     * same call `create` makes, so both doors ask the same question.
     */
    if (input.warehouseId !== undefined) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);
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
    // The gate sits on the entry read, so an out-of-scope dispatch never reaches
    // the claim and cannot burn an idempotency key either. The re-read at the
    // tail runs inside the transaction this has already been gated for.
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [shipment] = await this.db.select().from(invShipments).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId), this.shipmentInScope(scope))).limit(1);
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
    // A3. The key used to reach this method and stop here, recorded as audit
    // metadata and never claimed. The status read above is not a substitute: it
    // happens outside the write, so two copies of the same request in flight
    // together both see PACKED, both flip the row and both emit
    // `inventory.shipment.dispatched` -- two dispatches to the carrier for one
    // shipment. The claim and the dispatch share this transaction, so the event
    // is emitted exactly as often as the key is claimed.
    const updated = await this.db.transaction(async (tx) => {
      await runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        {
          shipmentId,
          trackingNumber: safeInput.trackingNumber ?? null,
          carrierId: safeInput.carrierId ?? null,
        },
        async () => {
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
          await OutboxWriter.emit(tx, {
            eventId: randomUUID(),
            organizationId: orgId,
            aggregateType: "inv_shipment",
            aggregateId: String(shipmentId),
            aggregateVersion: Date.now(),
            eventType: "inventory.shipment.dispatched",
            payload: {
              shipmentId,
              shipmentNumber: rows[0]?.shipmentNumber ?? shipment.shipmentNumber,
              soId: shipment.soId,
              // A5. Purely additive. The sales-order fulfilment path now emits
              // this same event for the shipments it raises, so a consumer that
              // cares which command shipped can tell without inferring it from
              // the absence of a field.
              shippedVia: "shipment.ship",
              actorUserId: userId,
            },
            occurredAt: new Date(),
          });
          return { shipmentId };
        },
        // The row is re-read below on both paths rather than revived from the
        // stored JSON, so a replay answers with the shipment as it now stands
        // and no `Date` has to survive a round trip through jsonb.
        () => ({ shipmentId }),
      );
      const [row] = await tx.select().from(invShipments)
        .where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId))).limit(1);
      return row;
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invShipmentsNamespace(orgId));
    return updated;
  }

  async cancel(orgId: string, userId: string, shipmentId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [shipment] = await this.db.select().from(invShipments).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId), this.shipmentInScope(scope))).limit(1);
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
