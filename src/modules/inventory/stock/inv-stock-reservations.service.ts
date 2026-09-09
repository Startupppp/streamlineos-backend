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
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import type { ListReservationsInput, CreateReservationInput, ReleaseReservationInput, OpeningStockInput } from "./dto/inv-stock.schemas";
import { loadOrderableVariants, loadCorrectableVariants } from "../products/lib/orderable-variants";
import { AccessService } from "../../access/access.service";
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

/**
 * D2 — what an override record has to say, decided by asking what a reviewer
 * needs six months later to answer "who shipped the short-dated stock, and why".
 *
 * Everything here is a snapshot rather than a join. The lot may have been
 * consumed and purged, and the settings certainly may have been edited — a row
 * that has to join `inv_settings` to explain itself explains itself differently
 * every time somebody changes a setting, which is the opposite of a trail.
 */
interface OverrideFacts {
  /** Which rule was set aside: the org's near-expiry block, or a customer floor. */
  readonly rule: OverriddenRule;
  readonly reason: string;
  readonly lotId: number;
  readonly lotNumber: string;
  readonly lotExpiryDate: string;
  readonly daysRemaining: number;
  readonly nearExpiryPolicy: string;
  readonly nearExpiryWindowDays: number;
  readonly minShelfLifeDays: number;
  /** Who receives it — null when the reservation names no customer document. */
  readonly clientId: number | null;
}

type LotChoiceOutcome = { overridden: false } | { overridden: true; facts: OverrideFacts };

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
   * D2 — the gate on choosing a lot the allocator would not have.
   *
   * Runs before the reservation is opened, and answers three ways:
   *
   *   * the lot is fine → nothing happens, and an `overrideReason` on a lot that
   *     needed no override is refused rather than silently recorded, because a
   *     row saying "overridden" about an ordinary allocation is a false trail
   *     through the audit log;
   *   * the lot is short-dated, or below the shelf life this customer contracted
   *     for → needs `inventory:allocation:override` **and** a reason, and the
   *     pair is recorded;
   *   * the lot is expired, recalled, blocked or consumed → refused outright.
   *     No permission reaches it: making those overridable would turn
   *     `expiryReservationPolicy: BLOCK` into a suggestion.
   */
  private async assertLotChoiceAllowed(
    orgId: string,
    userId: string,
    input: CreateReservationInput,
  ): Promise<LotChoiceOutcome> {
    if (input.lotId === undefined) {
      if (input.overrideReason !== undefined) {
        throw new BadRequestException(
          "An override reason was given for a reservation that names no lot — there is nothing to override.",
        );
      }
      return { overridden: false };
    }

    const settings = await this.settingsService.get(orgId);
    const lot = await this.db.query.invLots.findFirst({
      where: and(eq(invLots.orgId, orgId), eq(invLots.id, input.lotId)),
      columns: { id: true, lotNumber: true, expiryDate: true, status: true },
    });
    // A lot id from another tenant resolves to nothing here, and 404 is the
    // answer §4 requires — a 403 would confirm the row exists.
    if (!lot) throw new NotFoundException("Lot not found");

    // D2. The same floor `autoReserve` applied, resolved through the same helper
    // so a hand-raised reservation and an automatic one cannot hold two opinions
    // about what this customer agreed to accept.
    const clientId = await clientBehindSource(this.db, orgId, input.sourceType, input.sourceId);
    const floor = await resolveShelfLifeFloor(this.db, orgId, clientId);

    const lotById: ReadonlyMap<number, LotFacts> = new Map([[lot.id, lot]]);
    const policy: EligibilityPolicy = {
      expiryPolicy: settings.expiryReservationPolicy,
      nearExpiryPolicy: settings.nearExpiryPolicy,
      nearExpiryWindowDays: settings.nearExpiryWindowDays,
      minShelfLifeDays: floor.days,
    };
    const today = todayIso();
    const verdict = verdictFor(lot.id, lotById, policy, today);

    if (verdict.kind === "ELIGIBLE") {
      if (input.overrideReason !== undefined) {
        throw new BadRequestException(
          "That lot needs no override — the allocator would have chosen it.",
        );
      }
      return { overridden: false };
    }

    if (!overridable(verdict)) throw new BadRequestException(refusalMessage(verdict));

    if (!input.overrideReason) {
      throw new BadRequestException(
        `${refusalMessage(verdict)} Supply overrideReason to take it deliberately.`,
      );
    }

    await assertMayOverrideAllocation(this.access, orgId, userId);

    // Both are guaranteed by the branches above — `overridable` is only ever
    // true for a dated lot under one of the two judgement-call rules — but the
    // types do not know that, and a cast here would be a cast in the one place
    // the trail is written.
    const rule = overriddenRule(verdict);
    if (rule === null || lot.expiryDate === null) {
      throw new BadRequestException(refusalMessage(verdict));
    }

    return {
      overridden: true,
      facts: {
        rule,
        reason: input.overrideReason,
        lotId: lot.id,
        lotNumber: lot.lotNumber,
        lotExpiryDate: lot.expiryDate,
        daysRemaining: daysRemaining(lot.expiryDate, today),
        nearExpiryPolicy: settings.nearExpiryPolicy,
        nearExpiryWindowDays: settings.nearExpiryWindowDays,
        minShelfLifeDays: floor.days,
        clientId,
      },
    };
  }

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
    const choice = await this.assertLotChoiceAllowed(orgId, userId, input);

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
