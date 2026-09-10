import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { invLots, invStockReservations } from "../../../db/schema";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { ReservationService } from "../stock-engine/reservation.service";
import {
  INVENTORY_COMMAND_EVENTS,
  describeGrain,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import type { ListReservationsInput, CreateReservationInput, ReleaseReservationInput, OpeningStockInput } from "./dto/inv-stock.schemas";
import { loadOrderableVariants, loadCorrectableVariants } from "../products/lib/orderable-variants";
import { AccessService } from "../../access/access.service";
import {
  assertLotChoiceAllowed,
  type LotChoiceOutcome,
  type OverrideFacts,
} from "./lib/lot-choice";
export type { LotChoiceOutcome, OverrideFacts } from "./lib/lot-choice";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import {
  assertMayOverrideAllocation,
  daysRemaining,
  overridable,
  overriddenRule,
  refusalMessage,
  todayIso,
  verdictFor,
  type EligibilityPolicy,
  type LotFacts,
  type OverriddenRule,
} from "../sales-orders/lot-eligibility";
import { clientBehindSource, resolveShelfLifeFloor } from "../settings/min-shelf-life";
import { invAllocationOverrides } from "../../../db/schema";


@Injectable()
export class InvStockReservationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly reservationService: ReservationService,
    private readonly engine: StockEngineService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly access: AccessService,
    private readonly settingsService: InventorySettingsService,
    private readonly audit: InventoryAuditService,
  ) {}

  /**
   * Which reservations this caller may see — the list's rule, now the only copy.
   *
   * Both columns are nullable, so a reservation may be attributed by either. A
   * row attributed by neither names no warehouse at all and stays invisible to a
   * warehouse-scoped caller. `anyOf` rather than both: this row IS the example
   * in `ResolvedWarehouseScope`'s own note — requiring both would deny a
   * reservation whose location is in scope purely because its warehouse column
   * is null.
   */
  private reservationInScope(scope: ResolvedWarehouseScope): SQL {
    return scope.anyOf(
      scope.warehouse(sql`${invStockReservations.warehouseId}`),
      scope.location(sql`${invStockReservations.locationId}`),
    );
  }

  /**
   * The gate for a command that names a reservation by id.
   *
   * `releaseReservation` took `input.reservationId` off the request body and
   * carried it to `releaseReservationInTx`, which filters on `org_id` alone —
   * it takes a `userId` and spends it on nothing. So a scoped operator could
   * release a hold in a building they hold nothing in.
   *
   * That is the mirror of the create-side gate above, and it is NOT inert the
   * way the return drafts were. Releasing decrements `committed` and hands the
   * quantity straight back to general availability: the people who do hold the
   * building lose a promise they made, their availability moves under them, and
   * nothing in their view says who did it. The create-side note reads
   * "it makes that quantity unavailable to the people who DO hold the
   * building"; this is the same sentence with the sign flipped.
   *
   * 404 on a miss, never 403 (§4) — a "forbidden" on a reservation id confirms
   * the reservation exists.
   */
  private async assertReservationVisible(orgId: string, userId: string, reservationId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [visible] = await this.db
      .select({ id: invStockReservations.id })
      .from(invStockReservations)
      .where(and(
        eq(invStockReservations.orgId, orgId),
        eq(invStockReservations.id, reservationId),
        this.reservationInScope(scope),
      ))
      .limit(1);
    if (!visible) throw new NotFoundException("Reservation not found");
  }

  async listReservations(orgId: string, userId: string, filters: ListReservationsInput) {
    const { sourceType, status, variantId, warehouseId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${sourceType ?? ""}:${status ?? ""}:${variantId ?? ""}:${warehouseId ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(`inv:reservations:list:${orgId}`, hash, async () => {
      const conditions: SQL[] = [
        eq(invStockReservations.orgId, orgId),
        this.reservationInScope(scope),
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
    /*
     * A reservation holds stock AT a location, so the caller has to hold the
     * building it is in. `input.locationId` came straight off the request body
     * and nothing on this path checked it: `assertLotChoiceAllowed` answers a
     * lot-selection policy question, and neither `ReservationService` nor the
     * engine's `assertLocationsInScope` sees this — reserving posts no
     * movements.
     *
     * Reserving somebody else's stock is quieter than moving it and worse in one
     * respect: it makes that quantity unavailable to the people who do hold the
     * building, and nothing in their view says who took it.
     *
     * FIRST, before the variant lookup below. A caller who may not see the
     * location should not cause a query on its behalf, and should not be able
     * to learn from a refusal's shape whether the variant is orderable. 404
     * rather than 403, so naming a location you cannot see does not confirm it
     * exists.
     */
    await this.warehouseScope.assertLocationVisible(orgId, userId, input.locationId);

    // A4. A reservation raised by hand is new demand and takes the demand gate.
    // Reservations created *for an existing document* go through
    // `createReservationInTx` and are deliberately not gated — discontinuing a
    // product must not strand an order already taken.
    await loadOrderableVariants(this.db, orgId, [input.productVariantId]);

    // D2. Before the claim, so a request that is going to be refused never
    // consumes its idempotency key — a caller fixing a missing reason and
    // retrying with the same key must not replay a stored refusal.
    const choice = await assertLotChoiceAllowed(this.db, this.settingsService, this.access, orgId, userId, input);

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

          // D2. The override is recorded inside the claim, beside the
          // reservation it justifies. Outside it, a retry would write a second
          // row for one decision and the trail would over-count deliberate
          // overrides — which is the number a quality investigation is actually
          // counting.
          //
          // Two writes, on purpose. `inv_audit_events` is the immutable event
          // log and its list endpoint deliberately does not project `after`
          // (D7's redaction line), so the reason in it is written and
          // unreadable. `inv_allocation_overrides` is the domain record: typed,
          // indexed and answerable — who, why, which rule, how short-dated the
          // lot actually was, what the policy said at the time, and which
          // customer received it. Neither replaces the other.
          if (choice.overridden) {
            const { facts } = choice;
            await tx.insert(invAllocationOverrides).values({
              orgId,
              actorUserId: userId,
              reason: facts.reason,
              verdict: facts.rule,
              productVariantId: created.productVariantId,
              lotId: facts.lotId,
              lotNumber: facts.lotNumber,
              lotExpiryDate: facts.lotExpiryDate,
              daysRemaining: facts.daysRemaining,
              nearExpiryPolicy: facts.nearExpiryPolicy,
              nearExpiryWindowDays: facts.nearExpiryWindowDays,
              minShelfLifeDays: facts.minShelfLifeDays,
              sourceType: created.sourceType,
              sourceId: created.sourceId,
              clientId: facts.clientId,
              reservationId: created.id,
            });

            await this.audit.insert(tx, {
              orgId,
              actorUserId: userId,
              action: "reservation.allocation_override",
              resourceType: "inv_stock_reservation",
              resourceId: String(created.id),
              after: {
                rule: facts.rule,
                lotId: created.lotId,
                lotNumber: facts.lotNumber,
                lotExpiryDate: facts.lotExpiryDate,
                daysRemaining: facts.daysRemaining,
                productVariantId: created.productVariantId,
                locationId: created.locationId,
                reservedQty: created.reservedQty,
                clientId: facts.clientId,
                nearExpiryPolicy: facts.nearExpiryPolicy,
                nearExpiryWindowDays: facts.nearExpiryWindowDays,
                minShelfLifeDays: facts.minShelfLifeDays,
                reason: facts.reason,
              },
            });
          }

          // A5. Inside the claim, so a retry replays the stored id and emits
          // nothing — an event outside it would fire again on every retry and
          // tell every consumer that a second reservation had been taken.
          const grain = await describeGrain(
            tx, orgId, created.productVariantId, created.locationId,
          );
          await emitInventoryCommandEvent(tx, {
            orgId,
            eventType: INVENTORY_COMMAND_EVENTS.RESERVATION_CREATED,
            aggregateType: "inv_stock_reservation",
            aggregateId: String(created.id),
            actorUserId: userId,
            payload: {
              reservationId: created.id,
              sourceType: created.sourceType,
              sourceId: created.sourceId,
              sourceLineId: created.sourceLineId,
              productVariantId: created.productVariantId,
              sku: grain.sku,
              locationId: created.locationId,
              warehouseId: created.warehouseId ?? grain.warehouseId,
              lotId: created.lotId,
              serialId: created.serialId,
              reservedQty: created.reservedQty,
              expiresAt: created.expiresAt?.toISOString() ?? null,
              idempotencyKey,
            },
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
    /*
     * You may release only a hold in a building you hold.
     *
     * BEFORE the claim, not inside it, for the reason the return posts gate
     * where they do: a release that is going to be refused must not consume the
     * caller's idempotency key, or a client correcting the id and retrying with
     * the same key replays a stored refusal instead of the release.
     *
     * The gate is HERE and deliberately not in `releaseReservationInTx`, which
     * is the same split as `createTransfer` / `createTransferInTx`. Five other
     * modules call that helper — cancelling a transfer, cancelling a sales
     * order, a project standing down a requirement, a pick substitution — and
     * every one of them releases the reservations belonging to its OWN
     * aggregate, found by `source_type` and `source_id` rather than by an id a
     * client named. Gating the shared helper would refuse a legitimate sales
     * order cancellation that spans two buildings; those paths owe a gate on
     * their own command, which is a different question from this one. This
     * method is the only place a caller names a reservation id directly.
     */
    await this.assertReservationVisible(orgId, userId, input.reservationId);

    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.stock.release-reservation", input },
        async () => {
          const released = await this.reservationService.releaseReservationInTx(
            tx, orgId, userId, input.reservationId,
          );

          // A5. Only a release that actually released anything is an event.
          // `releaseReservationInTx` is a no-op on a row that is not ACTIVE, so
          // emitting unconditionally would announce a release nobody performed
          // every time a stale request arrived.
          if (released) {
            const grain = await describeGrain(
              tx, orgId, released.productVariantId, released.locationId,
            );
            await emitInventoryCommandEvent(tx, {
              orgId,
              eventType: INVENTORY_COMMAND_EVENTS.RESERVATION_RELEASED,
              aggregateType: "inv_stock_reservation",
              aggregateId: String(released.id),
              actorUserId: userId,
              payload: {
                reservationId: released.id,
                sourceType: released.sourceType,
                sourceId: released.sourceId,
                productVariantId: released.productVariantId,
                sku: grain.sku,
                locationId: released.locationId,
                warehouseId: grain.warehouseId,
                lotId: released.lotId,
                serialId: released.serialId,
                releasedQty: released.reservedQty,
                idempotencyKey,
              },
            });
          }

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
