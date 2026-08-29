import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * D2 — the audited FEFO override, and near-expiry as a constraint rather than a
 * sort order.
 *
 * Two claims, and they are separable.
 *
 * **A customer's minimum shelf life removes lots.** The organisation's
 * near-expiry window is one number for the whole tenant and it decides an
 * *order* — `DEPRIORITIZE` takes short-dated stock last. That is invisible to a
 * customer, and FEFO makes it worse rather than better: FEFO reaches for the lot
 * closest to its date, which is precisely the one a supply agreement refuses.
 * The fixture below is built so the two cannot be confused — the short lot is 45
 * days out, comfortably *outside* a 30-day near-expiry window, and still below a
 * customer's contracted 120-day floor. Nothing the org's own settings say can
 * produce that refusal, and no reordering can undo it.
 *
 * **The override is attributable or it does not happen.** Without
 * `inventory:allocation:override` a reason is refused with 403; with it, the
 * reservation is taken and a row lands in `inv_allocation_overrides` naming who,
 * why, which rule was set aside, how short-dated the lot actually was, what the
 * policy said at the time and which customer received it — all of which a
 * reviewer needs six months later, and none of which survives in a boolean.
 *
 *   pnpm test:e2e:seeded --testPathPattern=allocation-override
 */

const BASE_PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:stock:reserve",
  "inventory:settings:manage",
  "inventory:audit:read",
] as const;

/** Dates relative to today, so nothing here rots as the calendar moves. */
function isoOffsetDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

interface Lot {
  lotId: number;
  locationId: number;
}

interface Scene {
  orgId: string;
  keeperId: string;
  supervisorId: string;
  variantId: number;
  warehouseId: number;
  clientId: number;
  soId: number;
  /** 400 days out — acceptable to anyone. */
  fresh: Lot;
  /** 45 days out: outside the near-expiry window, below the 120-day contract. */
  short: Lot;
  /** Recalled, and therefore not a judgement call at all. */
  recalled: Lot;
}

interface OverrideRow {
  actor_user_id: string;
  reason: string;
  verdict: string;
  lot_id: number;
  lot_number: string;
  lot_expiry_date: string;
  days_remaining: number;
  near_expiry_policy: string;
  near_expiry_window_days: number;
  min_shelf_life_days: number;
  source_type: string;
  source_id: string;
  client_id: number | null;
  reservation_id: number | null;
}

describe(`${SEEDED_HARNESS} audited allocation override and customer shelf life`, () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let keeperToken = "";
  let supervisorToken = "";
  let nosyToken = "";
  let teardown: () => Promise<void>;

  const server = () => app.app.getHttpServer();
  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      // Holds every key the flow needs *except* the override — so a 403 below is
      // the override key being absent, never an unrelated gate.
      .addMember("keeper", { permissionKeys: BASE_PERMISSIONS })
      .addMember("supervisor", {
        permissionKeys: [...BASE_PERMISSIONS, "inventory:allocation:override"],
      })
      // Inventory access, no audit key — the trail is not ambient reading.
      .addMember("nosy", { permissionKeys: ["inventory:stock:read"] })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
      (await db().execute<T>(q))[0]!;

    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const orgId = seeded.orgId;
      const keeperId = seeded.members["keeper"]!.userId;
      const supervisorId = seeded.members["supervisor"]!.userId;
      await db().execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${orgId}, 'inventory', true) ON CONFLICT DO NOTHING`);

      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${orgId}, ${uom.id}, 'Yoghurt', ${`SHELF-${tag}`}, 'LOT', ${keeperId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${orgId}, ${product.id}, 'Default', ${`SHELF-${tag}-V1`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, 'Chilled', ${`CH${tag}`}, ${keeperId}) RETURNING id`);

      /** Each lot gets its own bin, so a lot is choosable independently. */
      async function lot(alias: string, expiry: string, status: string): Promise<Lot> {
        const location = await one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${orgId}, ${warehouse.id}, ${alias}, ${`${alias}${tag}`.slice(0, 20)}, 'BIN')
          RETURNING id`);
        const row = await one<{ id: number }>(sql`
          INSERT INTO inv_lots (org_id, product_variant_id, lot_number, expiry_date, status)
          VALUES (${orgId}, ${variant.id}, ${`${alias}-${tag}`}, ${expiry}, ${sql.raw(`'${status}'`)})
          RETURNING id`);
        return { lotId: row.id, locationId: location.id };
      }

      const fresh = await lot("fresh", isoOffsetDays(400), "ACTIVE");
      const short = await lot("short", isoOffsetDays(45), "ACTIVE");
      const recalled = await lot("recalled", isoOffsetDays(400), "RECALLED");

      // The customer, and one order for them — a reservation names a document,
      // and the document is what carries the customer whose contract applies.
      //
      // The Party and its map row are part of what a customer *is* here: the
      // legacy `clients` table is being retired and every read of a customer's
      // name now goes through `client_party_map` → `business_parties`. A fixture
      // that inserted only the legacy row would be a customer no screen can name.
      const clientName = `Big Grocer ${tag}`;
      const client = await one<{ id: number }>(sql`
        INSERT INTO clients (org_id, name) VALUES (${orgId}, ${clientName}) RETURNING id`);
      const party = await one<{ party_id: string }>(sql`
        INSERT INTO business_parties (party_id, organization_id, party_type, name)
        VALUES (${randomUUID()}, ${orgId}, 'CUSTOMER', ${clientName})
        RETURNING party_id`);
      await db().execute(sql`
        INSERT INTO client_party_map (organization_id, client_id, party_id)
        VALUES (${orgId}, ${client.id}, ${party.party_id})`);
      const so = await one<{ id: number }>(sql`
        INSERT INTO inv_sales_orders
          (org_id, client_id, so_number, status, order_date, warehouse_id, created_by)
        VALUES (${orgId}, ${client.id}, ${`SO-${tag}`}, 'CONFIRMED', CURRENT_DATE,
                ${warehouse.id}, ${keeperId})
        RETURNING id`);

      return {
        orgId,
        keeperId,
        supervisorId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        clientId: client.id,
        soId: so.id,
        fresh,
        short,
        recalled,
      };
    });

    // Stock through the engine, so the projection is real. The fresh lot holds
    // only a handful of units and the short one holds plenty, so a large line
    // can be covered by the short lot alone — which is what makes "refused"
    // distinguishable from "there was nothing there".
    await runInNewTenantTransaction(db(), scene.orgId, async () => {
      const engine = app.app.get(StockEngineService);
      await engine.execute(scene.orgId, scene.keeperId, {
        idempotencyKey: `shelf-seed-${tag}`,
        sourceType: "shelf-life-fixture",
        sourceId: tag,
        postingDate: isoOffsetDays(0),
        movements: [
          { lot: scene.fresh, qty: "5.0000" },
          { lot: scene.short, qty: "500.0000" },
          { lot: scene.recalled, qty: "500.0000" },
        ].map(({ lot, qty }) => ({
          transactionType: "PURCHASE" as const,
          productVariantId: scene.variantId,
          locationId: lot.locationId,
          lotId: lot.lotId,
          quantityDelta: qty,
          unitCost: "1.0000",
        })),
      });
    });

    keeperToken = `Bearer ${await signSeededToken(scene.keeperId, scene.orgId)}`;
    supervisorToken = `Bearer ${await signSeededToken(scene.supervisorId, scene.orgId)}`;
    nosyToken = `Bearer ${await signSeededToken(seeded.members["nosy"]!.userId, scene.orgId)}`;
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  const allocate = (minShelfLifeDays: number, qty: string) =>
    asTenant(() =>
      app.app.get(SoLifecycleService).findAvailableLotForLine(
        scene.orgId,
        scene.variantId,
        scene.warehouseId,
        qty,
        "FEFO",
        "BLOCK",
        { nearExpiryPolicy: "DEPRIORITIZE", nearExpiryWindowDays: 30, minShelfLifeDays },
      ),
    );

  const putRule = (body: Record<string, unknown>, token = supervisorToken) =>
    request(server())
      .put("/inventory/settings/shelf-life-rules")
      .set("Authorization", token)
      .send(body);

  const reserve = (body: Record<string, unknown>, token: string) =>
    request(server())
      .post("/inventory/stock/reserve")
      .set("Authorization", token)
      .set("Idempotency-Key", `alloc-ovr-${randomUUID()}`)
      .send(body);

  const line = (suffix: string, lot: Lot, extra: Record<string, unknown> = {}) => ({
    sourceType: "inv_sales_order",
    sourceId: String(scene.soId),
    sourceLineId: suffix,
    productVariantId: scene.variantId,
    warehouseId: scene.warehouseId,
    locationId: lot.locationId,
    lotId: lot.lotId,
    qty: "1.0000",
    ...extra,
  });

  const overrideRows = async () =>
    asTenant(() =>
      db().execute<OverrideRow>(sql`
        SELECT actor_user_id, reason, verdict, lot_id, lot_number, lot_expiry_date::text,
               days_remaining, near_expiry_policy, near_expiry_window_days, min_shelf_life_days,
               source_type, source_id, client_id, reservation_id
        FROM inv_allocation_overrides
        WHERE org_id = ${scene.orgId}
        ORDER BY id`),
    );

  describe("the customer's contracted shelf life is a constraint, not an order", () => {
    it("is the organisation's own settings' business that it is NOT", async () => {
      // 45 days out under a 30-day window: the org has no opinion at all, and
      // the whole line is coverable from that lot. This is the baseline the next
      // assertion is measured against — without it, a refusal below could just
      // be an empty shelf.
      const chosen = await allocate(0, "50.0000");
      expect(chosen).not.toBeNull();
      expect(chosen!.lotId).toBe(scene.short.lotId);
    });

    it("removes the lot once the customer contracted for more than it has left", async () => {
      // No ordering rule can produce this. FEFO would have taken the short lot
      // first; deprioritizing would have taken it last; the contract takes it
      // out of the set.
      expect(await allocate(120, "50.0000")).toBeNull();
    });

    it("still fills a line the fresh lot can cover, so it constrains rather than blocks", async () => {
      const chosen = await allocate(120, "5.0000");
      expect(chosen).not.toBeNull();
      expect(chosen!.lotId).toBe(scene.fresh.lotId);
    });
  });

  describe("where the threshold lives", () => {
    it("stores the customer's floor and reports it back with the customer's name", async () => {
      const written = await putRule({ clientId: scene.clientId, minShelfLifeDays: 120 });
      expect(written.status).toBe(200);

      const listed = await request(server())
        .get("/inventory/settings/shelf-life-rules")
        .set("Authorization", supervisorToken);
      expect(listed.status).toBe(200);
      const items = (listed.body as { items: Array<Record<string, unknown>> }).items;
      const own = items.find((row) => row["clientId"] === scene.clientId);
      expect(own).toMatchObject({ minShelfLifeDays: 120, scope: "CUSTOMER" });
      // frontend §5 / backend §1: a settings screen showing a raw id is a bug.
      expect(own!["clientName"]).toEqual(expect.any(String));
    });

    it("refuses a customer from another tenant with 404, not a foreign-key error", async () => {
      const response = await putRule({ clientId: 2_147_483_000, minShelfLifeDays: 30 });
      expect(response.status).toBe(404);
    });

    it("treats a floor of zero as clearing the rule, not as storing a zero", async () => {
      const house = await putRule({ minShelfLifeDays: 10 });
      expect(house.status).toBe(200);
      const cleared = await putRule({ minShelfLifeDays: 0 });
      expect(cleared.status).toBe(200);
      expect((cleared.body as { cleared: boolean }).cleared).toBe(true);

      const listed = await request(server())
        .get("/inventory/settings/shelf-life-rules")
        .set("Authorization", supervisorToken);
      const items = (listed.body as { items: Array<Record<string, unknown>> }).items;
      expect(items.some((row) => row["clientId"] === null)).toBe(false);
      // Clearing the house rule left the customer's own contract alone.
      expect(items.some((row) => row["clientId"] === scene.clientId)).toBe(true);
    });
  });

  describe("the override", () => {
    it("refuses the short lot outright when no reason is given", async () => {
      const response = await reserve(line("no-reason", scene.short), keeperToken);
      expect(response.status).toBe(400);
      expect(String((response.body as { message?: string }).message)).toContain("minimum shelf life");
    });

    it("returns 403 for a reason from somebody without inventory:allocation:override", async () => {
      // The keeper holds every other key this request needs, so this is the
      // override gate and nothing else.
      const response = await reserve(
        line("no-permission", scene.short, {
          overrideReason: "Customer accepted short dating for this delivery",
        }),
        keeperToken,
      );
      expect(response.status).toBe(403);
      expect(await overrideRows()).toHaveLength(0);
    });

    it("cannot reach a recalled lot, with permission or without", async () => {
      // A recall is not a judgement call, so there is nothing for a permission
      // to authorise. If this were overridable, `expiryReservationPolicy: BLOCK`
      // would be a suggestion.
      const response = await reserve(
        line("recalled", scene.recalled, { overrideReason: "Buyer says it is fine" }),
        supervisorToken,
      );
      expect(response.status).toBe(400);
      expect(await overrideRows()).toHaveLength(0);
    });

    it("refuses a reason on a lot that needed none", async () => {
      // A row saying "overridden" about an ordinary allocation is a false trail,
      // and a trail with false rows is not a trail.
      const response = await reserve(
        line("needless", scene.fresh, { overrideReason: "Just in case" }),
        supervisorToken,
      );
      expect(response.status).toBe(400);
      expect(await overrideRows()).toHaveLength(0);
    });

    it("succeeds with the permission and leaves a trail naming who, why and what", async () => {
      const reason = "Customer signed off on 45-day stock for the Diwali promotion";
      const response = await reserve(
        line("granted", scene.short, { overrideReason: reason }),
        supervisorToken,
      );
      expect(response.status).toBe(201);

      const rows = await overrideRows();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;

      // Who, and why — the two halves of the word "audited".
      expect(row.actor_user_id).toBe(scene.supervisorId);
      expect(row.reason).toBe(reason);

      // Which rule was set aside. A boolean here could not tell an
      // organisation's own caution apart from a broken customer contract.
      expect(row.verdict).toBe("SHELF_LIFE");

      // How short-dated it actually was, snapshotted — the lot may be consumed
      // and purged long before anyone reads this.
      expect(row.lot_id).toBe(scene.short.lotId);
      expect(row.lot_number).toContain("short-");
      expect(row.lot_expiry_date).toBe(isoOffsetDays(45));
      expect(row.days_remaining).toBeGreaterThanOrEqual(44);
      expect(row.days_remaining).toBeLessThanOrEqual(45);

      // What the policy said at the time. Settings are mutable; without this the
      // row would explain itself differently after every settings edit.
      expect(row.near_expiry_policy).toBe("DEPRIORITIZE");
      expect(row.near_expiry_window_days).toBe(30);
      expect(row.min_shelf_life_days).toBe(120);

      // And where it went.
      expect(row.source_type).toBe("inv_sales_order");
      expect(row.source_id).toBe(String(scene.soId));
      expect(row.client_id).toBe(scene.clientId);
      expect(row.reservation_id).not.toBeNull();
    });

    it("writes the immutable audit event beside the record, not instead of it", async () => {
      const [event] = await asTenant(() =>
        db().execute<{ actor_user_id: string; reason: string; rule: string }>(sql`
          SELECT actor_user_id,
                 after->>'reason' AS reason,
                 after->>'rule' AS rule
          FROM inv_audit_events
          WHERE org_id = ${scene.orgId} AND action = 'reservation.allocation_override'`),
      );
      expect(event).toBeDefined();
      expect(event!.actor_user_id).toBe(scene.supervisorId);
      expect(event!.rule).toBe("SHELF_LIFE");
    });
  });

  describe("reading the trail back", () => {
    it("answers 'who shipped the short-dated stock, and why' from the lot number", async () => {
      const response = await request(server())
        .get(`/inventory/traceability/allocation-overrides?lotId=${scene.short.lotId}`)
        .set("Authorization", supervisorToken);
      expect(response.status).toBe(200);

      const items = (response.body as { items: Array<Record<string, unknown>> }).items;
      expect(items).toHaveLength(1);
      const row = items[0]!;
      expect(row["verdict"]).toBe("SHELF_LIFE");
      expect(row["reason"]).toContain("Diwali");
      // The reason is projected here, unlike the audit list: a trail whose "why"
      // cannot be retrieved is a bypass with paperwork.
      expect(row["actorUserId"]).toBe(scene.supervisorId);
      expect(row["clientId"]).toBe(scene.clientId);
      expect(row["daysRemaining"]).toBeLessThanOrEqual(45);
    });

    it("filters by customer, which is how a complaint arrives", async () => {
      const response = await request(server())
        .get(`/inventory/traceability/allocation-overrides?clientId=${scene.clientId}&verdict=SHELF_LIFE`)
        .set("Authorization", supervisorToken);
      expect(response.status).toBe(200);
      expect((response.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it("is gated: a member without inventory:audit:read cannot read it", async () => {
      const response = await request(server())
        .get("/inventory/traceability/allocation-overrides")
        .set("Authorization", nosyToken);
      expect(response.status).toBe(403);
    });
  });
});
