import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { invQualityHolds, invStockLevels } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import {
  INVENTORY_COMMAND_EVENTS,
  describeGrain,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
import type { ListHoldsQueryInput, CreateHoldInput } from "./dto/quality.schemas";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../stock-engine/warehouse-scope.service";

@Injectable()
export class HoldsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly engine: StockEngineService,
    private readonly audit: InventoryAuditService,
  ) {}

  /**
   * Which holds this caller may see, and the rule the detail below must match.
   *
   * A hold names the bin the units are standing in, so it is attributed through
   * `location_id` and nothing else. `locationPredicate` renders
   * `location_id IN (SELECT id FROM inv_locations WHERE warehouse_id IN (…))`,
   * and a hold with a NULL `location_id` therefore evaluates to NULL and is
   * **excluded** — an unattributed hold is invisible to a scoped operator.
   *
   * That is deliberately NOT the ASN rule, where an unattributed row stays
   * visible to everyone: an ASN header names its warehouse nullably because the
   * warehouse may not be known yet, whereas a hold without a bin is a hold
   * standing nowhere, and showing it to every operator in the org would be a
   * different list from the one this one has always been. Each detail follows
   * its own aggregate.
   */
  private holdInScope(scope: ResolvedWarehouseScope): SQL {
    return scope.location(sql`${invQualityHolds.locationId}`);
  }

  async list(orgId: string, userId: string, query: ListHoldsQueryInput) {
    const { status, productVariantId, page, limit } = query;
    const offset = (page - 1) * limit;
    // `scopeKey` rather than a hand-rolled join: this file now has two cache
    // keys carrying the discriminator and they must not drift apart.
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${status ?? ""}:${productVariantId ?? ""}:${limit}:${offset}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.invQualityHoldsNamespace(orgId),
      `list:${hash}`,
      async () => {
        const conditions = [eq(invQualityHolds.orgId, orgId)];
        conditions.push(this.holdInScope(scope));
        if (status) conditions.push(eq(invQualityHolds.status, status));
        if (productVariantId) conditions.push(eq(invQualityHolds.productVariantId, productVariantId));
        const where = and(...conditions);
        const [items, countResult] = await Promise.all([
          this.db.query.invQualityHolds.findMany({
            where,
            orderBy: [desc(invQualityHolds.createdAt)],
            limit,
            offset,
            with: {
              productVariant: {
                columns: { name: true, sku: true },
                with: {
                  product: { columns: { name: true } },
                },
              },
            },
          }),
          this.db.select({ count: sql<number>`count(*)::int` }).from(invQualityHolds).where(where),
        ]);
        const enriched = items.map(({ productVariant, ...hold }) => ({
          ...hold,
          variantName: productVariant?.name ?? undefined,
          variantSku: productVariant?.sku ?? undefined,
          productName: productVariant?.product?.name ?? undefined,
        }));
        return { items: enriched, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
      },
      CACHE_TTL.SHORT,
    );
  }

  /**
   * One hold, read by id — and, until now, read by anyone in the org.
   *
   * `list` beside it resolves the caller's warehouses and gates on them; this
   * took no `userId` at all, because the controller never passed one, so a hold
   * an operator could not see in the list was theirs to read whole by id.
   *
   * The cache key carries the scope discriminator, and that is not decoration.
   * Adding the predicate below while leaving the key as `detail:<id>` would have
   * made this WORSE than the unscoped read it replaces: the first caller's
   * narrowed answer would be stored under a scope-free key and served to the
   * next, defeating the filter in both directions — CLAUDE.md §6, and the reason
   * `scopeKey` exists at all.
   */
  async findOne(orgId: string, userId: string, holdId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.cache.cachedVersioned(
      CACHE_KEYS.invQualityHoldsNamespace(orgId),
      `detail:${scope.key}:${holdId}`,
      async () => {
        const row = await this.db.query.invQualityHolds.findFirst({
          where: and(
            eq(invQualityHolds.id, holdId),
            eq(invQualityHolds.orgId, orgId),
            this.holdInScope(scope),
          ),
        });
        // 404 rather than 403: a "forbidden" on an id the caller may not see
        // tells them the hold exists, which is the existence oracle §4 bars.
        if (!row) throw new NotFoundException("Not found");
        return row;
      },
      CACHE_TTL.SHORT,
    );
  }

  /**
   * A3. The engine claimed the key; the hold record did not.
   *
   * `engine.execute` replays a repeated key correctly — the quarantine movement
   * happens once — but the `inv_quality_holds` insert below sat outside that
   * claim and ran again on every retry. One quarantined quantity therefore grew
   * one hold document per attempt, and releasing one of them left its twin
   * ACTIVE against stock that is no longer held: an unreleasable hold on
   * nothing. The claim now spans the movement and the document together.
   *
   * The engine gets a derived key rather than this one. Claiming the same key
   * twice in one transaction is a duplicate, not a nesting, so passing it
   * straight through would 409 every first attempt.
   */
  async create(orgId: string, userId: string, idempotencyKey: string, input: CreateHoldInput) {
    const holdId = await this.db.transaction(async (tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        input,
        async () => {
          // The hold document is written BEFORE its movement, and the order is
          // load-bearing rather than incidental.
          //
          // Every hop of the lot-genealogy walk keys documents on
          // `(reference_type, reference_id)` — `expandDocuments` in
          // `traceability/lib/genealogy-queries.ts`. Posting first left nothing
          // to name, so this passed `String(orgId)` and every manually-raised
          // hold in the organisation collapsed into the one node
          // `QUALITY_HOLD:<orgId>`; expanding it reached every lot and serial
          // the tenant had ever held, and a trace from one quarantined batch
          // arrived at unrelated ones. `release` below and the recall path both
          // name their own aggregate, and this is the third.
          //
          // Nothing else moves. The claim, the transaction and the engine's
          // `HOLD_EXCEEDS_ON_HAND` refusal are unchanged — that refusal reads
          // the `inv_stock_levels` buckets and never this table, so the row
          // cannot count against itself, and a refused hold still rolls the
          // document back with the movement it could not post.
          const [hold] = await tx.insert(invQualityHolds).values({
            orgId,
            productVariantId: input.productVariantId,
            locationId: input.locationId,
            lotId: input.lotId ?? null,
            serialId: input.serialId ?? null,
            handlingUnitId: input.handlingUnitId ?? null,
            ownership: input.ownership ?? "OWNED",
            quantity: input.quantity,
            reason: input.reason,
            createdBy: userId,
          }).returning({ id: invQualityHolds.id });
          if (!hold) throw new ConflictException("Could not record the hold");

          await this.engine.executeInTx(tx, orgId, userId, {
            idempotencyKey: `${idempotencyKey}:stock`,
            sourceType: "QUALITY_HOLD",
            sourceId: String(hold.id),
            // One movement, not a transfer. `quality_hold_qty` is subtracted from
            // `on_hand` by the availability formula, so it is a subset of on_hand
            // and not a pool beside it — also decrementing ON_HAND would deduct the
            // same units twice and under-report goods still sitting on the shelf.
            movements: [
              {
                transactionType: "QUARANTINE_IN",
                productVariantId: input.productVariantId,
                locationId: input.locationId,
                lotId: input.lotId,
                serialId: input.serialId,
                handlingUnitId: input.handlingUnitId ?? null,
                ownership: input.ownership ?? "OWNED",
                quantityDelta: input.quantity,
                qualityBucket: "QUALITY_HOLD",
              },
            ],
          });
          await this.audit.insert(tx, {
            orgId, actorUserId: userId, action: "quality_hold.created",
            resourceType: "quality_hold", resourceId: String(hold.id),
            after: { productVariantId: input.productVariantId, quantity: input.quantity },
          });

          // A5. The audit row records who did it; it is not an event and
          // nothing subscribes to a table. Emitted inside the claim, so the
          // retry that already replayed the hold id emits nothing.
          const grain = await describeGrain(tx, orgId, input.productVariantId, input.locationId);
          await emitInventoryCommandEvent(tx, {
            orgId,
            eventType: INVENTORY_COMMAND_EVENTS.QUALITY_HOLD_CREATED,
            aggregateType: "inv_quality_hold",
            aggregateId: String(hold.id),
            actorUserId: userId,
            payload: {
              holdId: hold.id,
              productVariantId: input.productVariantId,
              sku: grain.sku,
              locationId: input.locationId,
              warehouseId: grain.warehouseId,
              lotId: input.lotId ?? null,
              serialId: input.serialId ?? null,
              handlingUnitId: input.handlingUnitId ?? null,
              ownership: input.ownership ?? "OWNED",
              quantity: input.quantity,
              reason: input.reason,
              idempotencyKey,
            },
          });

          return hold.id;
        },
        // The stored id has been through jsonb and may come back as a string,
        // so it is parsed rather than cast; a garbled row fails loudly here
        // instead of becoming a NaN lookup that finds nothing.
        (stored) => {
          const id = revivedId(stored);
          if (!Number.isInteger(id))
            throw new ConflictException("The stored result for this key is unreadable");
          return id;
        },
      ),
    );
    // `executeInTx` does not invalidate on its own the way `execute` did.
    await Promise.all([
      this.engine.invalidateCaches(orgId),
      this.cache.invalidateNamespace(CACHE_KEYS.invQualityHoldsNamespace(orgId)),
    ]);
    return this.loadHoldUnscoped(orgId, holdId);
  }

  /**
   * The hold, read without the warehouse gate.
   *
   * For the two paths that hand back a row the caller has just written or has
   * already been gated for: `create`, where gating would 404 an operator against
   * the hold they just raised, and the tail of `release`, which has run the gate
   * above. A named private method rather than a flag on `findOne`, so a future
   * route cannot be pointed at the ungated read by accident.
   */
  private loadHoldUnscoped(orgId: string, holdId: number) {
    return this.db.query.invQualityHolds.findFirst({
      where: and(eq(invQualityHolds.id, holdId), eq(invQualityHolds.orgId, orgId)),
    });
  }

  /**
   * Releasing a hold was gated at the wrong end.
   *
   * `engine.execute` refuses movements into a warehouse the caller does not
   * hold, so the *movement* was covered — but two things sat in front of it.
   * The status read above it answered on `org_id` and the id alone, so an
   * out-of-scope hold could be distinguished by whether it came back 409
   * "Invalid state" or 404. And where a hold names no bin, the fallback below
   * picks whichever location in the ORG holds that variant: pick one inside the
   * caller's own warehouses and `assertLocationsInScope` passes, so a hold they
   * cannot see is released for real. The gate belongs on the read, matching
   * `list`.
   */
  async release(orgId: string, userId: string, holdId: number, idempotencyKey: string) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hold = await this.db.query.invQualityHolds.findFirst({
      where: and(
        eq(invQualityHolds.id, holdId),
        eq(invQualityHolds.orgId, orgId),
        this.holdInScope(scope),
      ),
    });
    if (!hold) throw new NotFoundException("Not found");
    if (hold.status !== "ACTIVE") throw new ConflictException("Invalid state");

    let locationId = hold.locationId;
    if (!locationId) {
      const [level] = await this.db.select({ locationId: invStockLevels.locationId })
        .from(invStockLevels)
        .where(and(
          eq(invStockLevels.orgId, orgId),
          eq(invStockLevels.productVariantId, hold.productVariantId),
        ))
        .limit(1);
      locationId = level?.locationId ?? null;
    }
    if (!locationId) throw new ConflictException("No stock location found for hold");

    await this.engine.execute(orgId, userId, {
      idempotencyKey,
      sourceType: "QUALITY_HOLD_RELEASE",
      sourceId: String(holdId),
      // The mirror of `create`: the units never left ON_HAND, so releasing
      // them only clears the hold bucket.
      movements: [
        {
          transactionType: "QUARANTINE_OUT",
          productVariantId: hold.productVariantId,
          locationId,
          lotId: hold.lotId ?? undefined,
          serialId: hold.serialId ?? undefined,
          handlingUnitId: hold.handlingUnitId ?? null,
          ownership: hold.ownership,
          quantityDelta: "-" + hold.quantity,
          qualityBucket: "QUALITY_HOLD",
        },
      ],
    });

    // A5. The status flip, its audit row and its event now share a transaction.
    // They were three independent writes, so a release could be recorded with
    // no audit trail; and an event written outside the transaction that
    // committed the release is an announcement that may outlive the fact.
    await this.db.transaction(async (tx) => {
      const released = await tx.update(invQualityHolds)
        .set({ status: "RELEASED", releasedBy: userId, releasedAt: new Date() })
        .where(and(
          eq(invQualityHolds.id, holdId),
          eq(invQualityHolds.orgId, orgId),
          // Compare-and-set on the status the caller read above. Two concurrent
          // releases both pass that read; only one of them changes a row, and
          // only that one is entitled to say the hold was released.
          eq(invQualityHolds.status, "ACTIVE"),
        ))
        .returning({ id: invQualityHolds.id });

      if (released.length === 0) return;

      await this.audit.insert(tx, {
        orgId, actorUserId: userId, action: "quality_hold.released",
        resourceType: "quality_hold", resourceId: String(holdId),
      });

      const grain = await describeGrain(tx, orgId, hold.productVariantId, locationId);
      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.QUALITY_HOLD_RELEASED,
        aggregateType: "inv_quality_hold",
        aggregateId: String(holdId),
        actorUserId: userId,
        payload: {
          holdId,
          productVariantId: hold.productVariantId,
          sku: grain.sku,
          locationId,
          warehouseId: grain.warehouseId,
          lotId: hold.lotId,
          serialId: hold.serialId,
          handlingUnitId: hold.handlingUnitId ?? null,
          ownership: hold.ownership,
          quantity: hold.quantity,
          reason: hold.reason,
          idempotencyKey,
        },
      });
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityHoldsNamespace(orgId));
    return this.loadHoldUnscoped(orgId, holdId);
  }
}
