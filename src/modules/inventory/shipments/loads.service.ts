import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";
import { and, eq, desc, inArray, sql, type SQL } from "drizzle-orm";
import {
  invLoads,
  invLoadLines,
  invShipments,
  invStockTransfers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService, type ResolvedWarehouseScope } from "../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { ListLoadsQueryInput, CreateLoadInput, DispatchLoadInput, CloseLoadInput } from "./dto/shipments.schemas";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";

@Injectable()
export class LoadsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * Which loads this caller may see — the list's rule, now the only copy.
   *
   * A load is attributed by the warehouse it leaves from. `NULL IN (…)` is NULL,
   * so a load naming no source warehouse is invisible to a scoped operator, and
   * that is the list's existing behaviour rather than a new restriction; each
   * detail follows its own aggregate.
   *
   * Private and single so the detail reads cannot drift from the list.
   */
  private loadInScope(scope: ResolvedWarehouseScope): SQL {
    return scope.warehouse(sql`${invLoads.sourceWarehouseId}`);
  }

  /**
   * You may pull onto a load only documents out of a warehouse you hold.
   *
   * `create` took `shipmentIds` and `transferIds` straight from the body to the
   * insert. Nothing asked whose building they came out of — nothing asked
   * whether they were even this ORGANISATION'S — so any shipment in the tenant
   * could be pulled onto a stranger's load, and dispatching that load then reads
   * and reports their statuses.
   *
   * Each document is measured by its OWN aggregate's rule rather than a rule
   * invented here: a shipment by its warehouse column, a transfer by BOTH of its
   * ends, which is how `listTransfers` scopes one — seeing a single leg would
   * expose the counterpart warehouse's movement. 404, never 403: naming an id
   * you may not see must not confirm it exists.
   */
  private async assertLinesInScope(
    orgId: string,
    userId: string,
    shipmentIds: readonly number[],
    transferIds: readonly number[],
  ): Promise<void> {
    if (shipmentIds.length === 0 && transferIds.length === 0) return;
    const scope = await this.warehouseScope.forUser(orgId, userId);

    if (shipmentIds.length > 0) {
      const unique = Array.from(new Set(shipmentIds));
      const visible = await this.db
        .select({ id: invShipments.id })
        .from(invShipments)
        .where(and(
          eq(invShipments.orgId, orgId),
          inArray(invShipments.id, unique),
          scope.warehouse(sql`${invShipments.warehouseId}`),
        ));
      if (visible.length !== unique.length) throw new NotFoundException("Shipment not found");
    }

    if (transferIds.length > 0) {
      const unique = Array.from(new Set(transferIds));
      const visible = await this.db
        .select({ id: invStockTransfers.id })
        .from(invStockTransfers)
        .where(and(
          eq(invStockTransfers.orgId, orgId),
          inArray(invStockTransfers.id, unique),
          scope.location(sql`${invStockTransfers.fromLocationId}`),
          scope.location(sql`${invStockTransfers.toLocationId}`),
        ));
      if (visible.length !== unique.length) throw new NotFoundException("Transfer not found");
    }
  }

  async list(orgId: string, userId: string, query: ListLoadsQueryInput) {
    const { status, carrierId, page, limit } = query;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${status ?? ""}:${carrierId ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invLoadsNamespace(orgId), `list:${hash}`, async () => {
      const conditions = [eq(invLoads.orgId, orgId), this.loadInScope(scope)];
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

  /**
   * One load, read by id — and, until now, by anyone in the org.
   *
   * The scope discriminator is in the cache key for the reason §6 gives: a
   * perfect predicate under a scope-free `detail:<id>` key would store one
   * caller's narrowed answer and serve it to the next, which defeats the filter
   * in both directions and would be worse than the unscoped read it replaces.
   */
  async findOne(orgId: string, userId: string, loadId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.cache.cachedVersioned(CACHE_KEYS.invLoadsNamespace(orgId), `detail:${scope.key}:${loadId}`, async () => {
      const [load] = await this.db.select().from(invLoads).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId), this.loadInScope(scope))).limit(1);
      // 404, never 403 (§4) — a "forbidden" on a load id confirms it exists.
      if (!load) throw new NotFoundException("Load not found");
      const lines = await this.db.select().from(invLoadLines).where(eq(invLoadLines.loadId, loadId));
      return { ...load, lines };
    }, CACHE_TTL.MEDIUM);
  }

  async create(orgId: string, userId: string, input: CreateLoadInput) {
    /*
     * A load leaves OUT of a warehouse, so the same rule as a shipment's:
     * only out of a building you hold. `sourceWarehouseId` came straight off the
     * request body and was written unchecked, and nothing downstream catches it
     * — raising or dispatching a load posts no movements, so the stock engine's
     * `assertLocationsInScope` never runs on this path.
     *
     * Only asserted when one is given, matching `ShipmentsService.create`: the
     * column is nullable and a load with no source yet is a legitimate draft.
     */
    if (input.sourceWarehouseId != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.sourceWarehouseId);
    }
    await this.assertLinesInScope(orgId, userId, input.shipmentIds ?? [], input.transferIds ?? []);

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

      const lineValues: Array<{ orgId: string; loadId: number; shipmentId: number | null; transferId: number | null }> = [];
      for (const sid of input.shipmentIds ?? []) {
        lineValues.push({ orgId, loadId: row!.id, shipmentId: sid, transferId: null });
      }
      for (const tid of input.transferIds ?? []) {
        lineValues.push({ orgId, loadId: row!.id, shipmentId: null, transferId: tid });
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
    await this.cache.invalidateNamespace(CACHE_KEYS.invLoadsNamespace(orgId));
    return load;
  }

  /**
   * A3/T04. Dispatching a load took no key. The DRAFT guard makes a repeat safe,
   * but a client retrying a timed-out dispatch was told the load was not DRAFT —
   * the dispatch had in fact happened, and the driver had left.
   *
   * The key was added and the guard was left in front of it, so the sentence
   * above stayed true: the first call sets DISPATCHED, and the retry was refused
   * on the status its own first run had set, without ever reaching `runIdempotent`.
   * The DRAFT check now runs inside the claim, so a replay returns the first
   * answer and only a genuinely non-DRAFT load is refused.
   *
   * The shipment and transfer checks below stay outside deliberately: dispatch
   * does not change a shipment's or a transfer's status, so they are preconditions
   * this command cannot invalidate, and failing them early costs no key.
   */
  async dispatch(orgId: string, userId: string, loadId: number, input: DispatchLoadInput, idempotencyKey: string) {
    // Existence only. The DRAFT check moved inside the claim, so nothing out here
    // needs the row itself — §3, select only the columns you use.
    // Gated here, so an out-of-scope dispatch never reaches the claim and cannot
    // burn an idempotency key. The re-read inside the transaction runs behind
    // this one.
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [load] = await this.db.select({ id: invLoads.id }).from(invLoads)
      .where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId), this.loadInScope(scope))).limit(1);
    if (!load) throw new NotFoundException("Load not found");

    const lines = await this.db.select().from(invLoadLines).where(eq(invLoadLines.loadId, loadId));

    const shipmentIds = lines.map((l) => l.shipmentId).filter((id): id is number => id != null);
    const transferIds = lines.map((l) => l.transferId).filter((id): id is number => id != null);

    const [shipmentsResult, transfersResult] = await Promise.all([
      shipmentIds.length > 0
        ? this.db.select({ id: invShipments.id, status: invShipments.status })
            .from(invShipments)
            .where(and(eq(invShipments.orgId, orgId), inArray(invShipments.id, shipmentIds)))
        : Promise.resolve([] as Array<{ id: number; status: string }>),
      transferIds.length > 0
        ? this.db.select({ id: invStockTransfers.id, status: invStockTransfers.status })
            .from(invStockTransfers)
            .where(and(eq(invStockTransfers.orgId, orgId), inArray(invStockTransfers.id, transferIds)))
        : Promise.resolve([] as Array<{ id: number; status: string }>),
    ]);

    const shipmentStatusMap = new Map(shipmentsResult.map((s) => [s.id, s.status]));
    const transferStatusMap = new Map(transfersResult.map((t) => [t.id, t.status]));

    for (const line of lines) {
      if (line.shipmentId != null) {
        const status = shipmentStatusMap.get(line.shipmentId);
        if (status !== undefined && status !== "SHIPPED") {
          throw new BadRequestException("All shipments must be SHIPPED before dispatching");
        }
      }
      if (line.transferId != null) {
        const status = transferStatusMap.get(line.transferId);
        if (status !== undefined && status !== "IN_TRANSIT") {
          throw new BadRequestException("All transfers must be IN_TRANSIT before dispatching");
        }
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const dispatchedId = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.loads.dispatch", loadId, input },
        async () => {
          // Read through `tx` so the check sees the same snapshot the write does.
          const [current] = await tx.select({ status: invLoads.status }).from(invLoads)
            .where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId))).limit(1);
          if (!current) throw new NotFoundException("Load not found");
          if (current.status !== "DRAFT") throw new ConflictException("Load must be DRAFT to dispatch");

          await tx.update(invLoads).set({
            status: "DISPATCHED",
            dispatchDate: input.dispatchDate ?? today,
            updatedAt: new Date(),
          }).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId)));
          await this.audit.insert(tx, {
            orgId,
            actorUserId: userId,
            action: "load.dispatched",
            resourceType: "load",
            resourceId: String(loadId),
          });
          return loadId;
        },
        revivedId,
      ),
    );

    await this.cache.invalidateNamespace(CACHE_KEYS.invLoadsNamespace(orgId));
    const [updated] = await this.db.select().from(invLoads)
      .where(and(eq(invLoads.id, dispatchedId), eq(invLoads.orgId, orgId))).limit(1);
    return updated;
  }

  async close(orgId: string, userId: string, loadId: number, input: CloseLoadInput) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [load] = await this.db.select().from(invLoads).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId), this.loadInScope(scope))).limit(1);
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
    await this.cache.invalidateNamespace(CACHE_KEYS.invLoadsNamespace(orgId));
    return updated;
  }

  async cancel(orgId: string, userId: string, loadId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [load] = await this.db.select().from(invLoads).where(and(eq(invLoads.id, loadId), eq(invLoads.orgId, orgId), this.loadInScope(scope))).limit(1);
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
    await this.cache.invalidateNamespace(CACHE_KEYS.invLoadsNamespace(orgId));
    return updated;
  }
}
