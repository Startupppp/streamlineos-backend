import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InvStockReservationsService } from "src/modules/inventory/stock/inv-stock-reservations.service";
import { INVENTORY_COMMAND_EVENTS } from "src/modules/inventory/stock-engine/command-events";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { outboxEventsFor } from "test/helpers/outbox-events";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * A3 — the three properties an idempotency key is supposed to have.
 *
 * Same key and same body replays; same key and a different body is refused; a
 * missing key is refused. The first of those is the one that was broken and the
 * one that matters: `stock/reserve` demanded a key, threw without it, and then
 * called the service without it, so a retried reserve inserted a *second*
 * ACTIVE reservation and incremented `committed` again — the same stock held
 * twice against one order, and subtracted twice from everything that reads
 * availability.
 *
 * Exercised through the service rather than HTTP because that is where the key
 * has to arrive. A route can be perfectly decorated and still drop it on the
 * way down, which is exactly what happened.
 */
interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  sku: string;
  locationId: number;
  warehouseId: number;
}

describe("[seeded-e2e] stock commands are idempotent", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const reservations = () => app.app.get(InvStockReservationsService);

  const position = async () => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ committed: string; holds: string }>(sql`
        SELECT
          (SELECT COALESCE(SUM(committed), 0)::text FROM inv_stock_levels
            WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}) AS committed,
          (SELECT count(*)::text FROM inv_stock_reservations
            WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}
              AND status = 'ACTIVE') AS holds`),
    );
    return { committed: Number(row!.committed), holds: Number(row!.holds) };
  };

  const reserveInput = (qty: string, sourceId: string) => ({
    sourceType: "manual",
    sourceId,
    productVariantId: scene.variantId,
    locationId: scene.locationId,
    qty,
  });

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:stock:read",
          "inventory:stock:adjust",
          "inventory:stock:reserve",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["keeper"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Retried goods', ${`ID-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`ID-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`IW${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`IB${tag}`}, 'BIN', true) RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        sku: `ID-${tag}-V`,
        locationId: location.id,
        warehouseId: warehouse.id,
      };
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `idem-seed-${tag}`,
        sourceType: "idempotency-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "500.0000",
            unitCost: "1.0000",
          },
        ],
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  it("replays a reserve rather than holding the same stock twice", async () => {
    const key = `reserve-replay-${randomUUID().slice(0, 8)}`;
    const input = reserveInput("30.0000", key);

    const before = await position();
    const first = await asTenant(() =>
      reservations().createReservation(scene.orgId, scene.userId, input, key),
    );
    const once = await position();
    expect(once.holds).toBe(before.holds + 1);
    expect(once.committed).toBe(before.committed + 30);

    // The same key again is a retry, not a second hold. Before A3 this made a
    // second ACTIVE reservation and committed 60 against an order for 30.
    const second = await asTenant(() =>
      reservations().createReservation(scene.orgId, scene.userId, input, key),
    );
    const twice = await position();

    expect(second.id).toBe(first.id);
    expect(twice).toEqual(once);
  });

  it("refuses the same key with a different request", async () => {
    const key = `reserve-mismatch-${randomUUID().slice(0, 8)}`;
    await asTenant(() =>
      reservations().createReservation(scene.orgId, scene.userId, reserveInput("5.0000", key), key),
    );

    const before = await position();
    await expect(
      asTenant(() =>
        reservations().createReservation(
          scene.orgId,
          scene.userId,
          reserveInput("999.0000", key),
          key,
        ),
      ),
    ).rejects.toThrow(/already used with a different request/i);

    // And it changed nothing on the way to refusing.
    expect(await position()).toEqual(before);
  });

  it("refuses a command with no key at all", async () => {
    const before = await position();
    await expect(
      asTenant(() =>
        reservations().createReservation(
          scene.orgId,
          scene.userId,
          reserveInput("7.0000", "no-key"),
          "",
        ),
      ),
    ).rejects.toThrow(/Idempotency-Key is required/i);
    expect(await position()).toEqual(before);
  });

  it("releases once, however many times the release is retried", async () => {
    const reserveKey = `release-replay-${randomUUID().slice(0, 8)}`;
    const created = await asTenant(() =>
      reservations().createReservation(
        scene.orgId,
        scene.userId,
        reserveInput("12.0000", reserveKey),
        reserveKey,
      ),
    );

    const held = await position();
    const releaseKey = `${reserveKey}-release`;
    const release = () =>
      asTenant(() =>
        reservations().releaseReservation(
          scene.orgId,
          scene.userId,
          { reservationId: created.id },
          releaseKey,
        ),
      );

    await release();
    const once = await position();
    expect(once.committed).toBe(held.committed - 12);

    await release();
    expect(await position()).toEqual(once);
  });

  /**
   * A5, item 3 — the events a reservation owes.
   *
   * Reserving and releasing changed `committed` and told nobody: an allocation
   * engine, a customer-facing availability page or a marketplace listing had no
   * way to hear that stock had been promised away, and the only record was a
   * row in a table nothing subscribes to.
   *
   * Counted rather than eyeballed, because the failure mode that matters is a
   * duplicate. Both commands claim an idempotency key, so the emit sits inside
   * the claimed work — an emit outside it fires again on every retry, which is
   * the duplicate notification the claim exists to prevent.
   */
  describe("the events a reservation owes", () => {
    const eventsFor = (eventType: string, aggregateId: string) =>
      asTenant(() =>
        outboxEventsFor(app.app.get<Db>(DRIZZLE), scene.orgId, eventType, aggregateId),
      );

    it("announces a reservation exactly once, and says nothing more on a retry", async () => {
      const key = `reserve-event-${randomUUID().slice(0, 8)}`;
      const input = reserveInput("9.0000", key);

      const created = await asTenant(() =>
        reservations().createReservation(scene.orgId, scene.userId, input, key),
      );

      const events = await eventsFor(
        INVENTORY_COMMAND_EVENTS.RESERVATION_CREATED,
        String(created.id),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.aggregateType).toBe("inv_stock_reservation");
      expect(events[0]!.payload.reservationId).toBe(created.id);
      expect(events[0]!.payload.reservedQty).toBe("9.0000");
      expect(events[0]!.payload.actorUserId).toBe(scene.userId);
      expect(events[0]!.payload.idempotencyKey).toBe(key);
      // Evidence, not a second ledger: the SKU and the warehouse are on the
      // event so a consumer holding a variant id does not have to join two
      // tables to learn what was promised away.
      expect(events[0]!.payload.sku).toBe(scene.sku);
      expect(events[0]!.payload.warehouseId).toBe(scene.warehouseId);

      await asTenant(() =>
        reservations().createReservation(scene.orgId, scene.userId, input, key),
      );
      expect(
        await eventsFor(INVENTORY_COMMAND_EVENTS.RESERVATION_CREATED, String(created.id)),
      ).toHaveLength(1);
    });

    it("announces a release once, and not at all for a release that released nothing", async () => {
      const reserveKey = `release-event-${randomUUID().slice(0, 8)}`;
      const created = await asTenant(() =>
        reservations().createReservation(
          scene.orgId,
          scene.userId,
          reserveInput("4.0000", reserveKey),
          reserveKey,
        ),
      );

      await asTenant(() =>
        reservations().releaseReservation(
          scene.orgId,
          scene.userId,
          { reservationId: created.id },
          `${reserveKey}-rel-1`,
        ),
      );
      const released = await eventsFor(
        INVENTORY_COMMAND_EVENTS.RESERVATION_RELEASED,
        String(created.id),
      );
      expect(released).toHaveLength(1);
      expect(released[0]!.payload.releasedQty).toBe("4.0000");
      expect(released[0]!.payload.sku).toBe(scene.sku);

      // A *different* key, so the idempotency claim cannot be what suppresses
      // the second event. The reservation is no longer ACTIVE, so nothing is
      // released and there is nothing to announce — the event tracks the state
      // change, not the arrival of a request.
      await asTenant(() =>
        reservations().releaseReservation(
          scene.orgId,
          scene.userId,
          { reservationId: created.id },
          `${reserveKey}-rel-2`,
        ),
      );
      expect(
        await eventsFor(INVENTORY_COMMAND_EVENTS.RESERVATION_RELEASED, String(created.id)),
      ).toHaveLength(1);
    });
  });
});
