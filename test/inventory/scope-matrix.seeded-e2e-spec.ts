import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-109 — the permission × warehouse-scope matrix, over HTTP.
 *
 * The distinction the whole ticket turns on is that **denial is not emptiness**.
 * A reader who may not look at stock must be refused; a reader who may look but
 * has been assigned no warehouse must be served an empty list. Collapsing those
 * into one response tells an operator "there is no stock" when the truth is
 * "you are not allowed to know", and it is the kind of bug that survives for
 * years because both look like a blank screen.
 *
 * Eight personas, expressed the way this system actually expresses capability:
 * permission bundles plus warehouse assignments, not invented role names.
 */

interface Persona {
  alias: string;
  permissions: string[];
  /** null = scope-all via permission; [] = assigned nothing; [1] = warehouse one */
  warehouses: "all" | "none" | "first";
  listStatus: number;
}

const SCOPE_ALL = "inventory:warehouses:scope-all";

const PERSONAS: Persona[] = [
  { alias: "manager", permissions: ["inventory:stock:read", SCOPE_ALL], warehouses: "all", listStatus: 200 },
  { alias: "planner", permissions: ["inventory:stock:read", "inventory:replenishment:manage", SCOPE_ALL], warehouses: "all", listStatus: 200 },
  { alias: "auditor", permissions: ["inventory:stock:read", "inventory:reports:read", SCOPE_ALL], warehouses: "all", listStatus: 200 },
  { alias: "supervisor", permissions: ["inventory:stock:read", "inventory:stock:adjust"], warehouses: "first", listStatus: 200 },
  { alias: "operator", permissions: ["inventory:stock:read"], warehouses: "first", listStatus: 200 },
  { alias: "quality", permissions: ["inventory:stock:read", "inventory:quality:read"], warehouses: "first", listStatus: 200 },
  // Holds the permission, assigned nowhere. Must be served an empty list, not
  // a refusal -- this is the case the ticket exists to pin down.
  { alias: "unassigned", permissions: ["inventory:stock:read"], warehouses: "none", listStatus: 200 },
  // Holds no inventory permission at all. Must be refused, not served empty.
  { alias: "outsider", permissions: ["inventory:reports:read"], warehouses: "none", listStatus: 403 },
];

describe(`${SEEDED_HARNESS} inventory permission and warehouse scope matrix`, () => {
  let app: SeededE2eApp;
  let orgId: string;
  let otherOrgId: string;
  let members: Record<string, string> = {};
  let warehouseOne = 0;
  let warehouseTwo = 0;
  let locationOne = 0;
  const teardowns: Array<() => Promise<void>> = [];

  const server = () => app.app.getHttpServer();
  const auth = async (alias: string, org = orgId) =>
    `Bearer ${await signSeededToken(app, members[alias]!, org)}`;

  async function enableInventory(target: string) {
    const db = app.app.get<Db>(DRIZZLE);
    await runInNewTenantTransaction(db, target, async () => {
      await db.execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${target}, 'inventory', true) ON CONFLICT DO NOTHING`);
    });
  }

  /** Two warehouses, each holding stock, so "scoped out" is a real row. */
  async function seedStock(target: string, userId: string, warehouses: number) {
    const db = app.app.get<Db>(DRIZZLE);
    const tag = randomUUID().slice(0, 6);
    return runInNewTenantTransaction(db, target, async () => {
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${target}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${target}, ${uom.id}, 'Matrix widget', ${`MX-${tag}`}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${target}, ${product.id}, 'Default', ${`MX-${tag}-V`}) RETURNING id`);

      const ids: Array<{ warehouseId: number; locationId: number }> = [];
      for (let i = 0; i < warehouses; i += 1) {
        const warehouse = await one<{ id: number }>(sql`
          INSERT INTO inv_warehouses (org_id, name, code, created_by)
          VALUES (${target}, ${`W${i}`}, ${`W${i}${tag}`}, ${userId}) RETURNING id`);
        const location = await one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${target}, ${warehouse.id}, ${`Bin ${i}`}, ${`B${i}${tag}`}, 'BIN') RETURNING id`);
        await db.execute(sql`
          INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand)
          VALUES (${target}, ${variant.id}, ${location.id}, 50)`);
        ids.push({ warehouseId: warehouse.id, locationId: location.id });
      }
      return ids;
    });
  }

  async function assignWarehouse(userId: string, warehouseId: number) {
    const db = app.app.get<Db>(DRIZZLE);
    await runInNewTenantTransaction(db, orgId, async () => {
      await db.execute(sql`
        INSERT INTO inv_user_warehouses (org_id, user_id, warehouse_id, granted_by)
        VALUES (${orgId}, ${userId}, ${warehouseId}, ${userId})
        ON CONFLICT DO NOTHING`);
    });
  }

  beforeAll(async () => {
    app = await createSeededE2eApp();

    let builder = seedOrg(app.seedDb).onPlan("PAID");
    for (const persona of PERSONAS) {
      builder = builder.addMember(persona.alias, { permissionKeys: persona.permissions });
    }
    const fixture = await builder.build();
    teardowns.push(() => fixture.teardown());
    orgId = fixture.orgId;
    members = Object.fromEntries(
      PERSONAS.map((p) => [p.alias, fixture.members[p.alias]!.userId]),
    );
    await enableInventory(orgId);

    const warehouses = await seedStock(orgId, members["manager"]!, 2);
    warehouseOne = warehouses[0]!.warehouseId;
    locationOne = warehouses[0]!.locationId;
    warehouseTwo = warehouses[1]!.warehouseId;

    for (const persona of PERSONAS) {
      if (persona.warehouses === "first") {
        await assignWarehouse(members[persona.alias]!, warehouseOne);
      }
    }

    // A second tenant with its own stock, so cross-tenant probing has a real
    // row to fail to find rather than an id that exists nowhere.
    const other = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("neighbour", { permissionKeys: ["inventory:stock:read", SCOPE_ALL] })
      .build();
    teardowns.push(() => other.teardown());
    otherOrgId = other.orgId;
    await enableInventory(otherOrgId);
    await seedStock(otherOrgId, other.members["neighbour"]!.userId, 1);
  }, 300_000);

  afterAll(async () => {
    for (const drop of teardowns) await drop().catch(() => undefined);
    await app.close();
  });

  it.each(PERSONAS.map((p) => [p.alias, p.listStatus] as const))(
    "%s gets %i from the stock list",
    async (alias, expected) => {
      const response = await request(server())
        .get("/inventory/stock")
        .set("Authorization", await auth(alias));
      expect({ alias, status: response.status }).toMatchObject({ alias, status: expected });
    },
    60_000,
  );

  it(
    "denial and emptiness are different answers",
    async () => {
      // The heart of the ticket. `outsider` may not look and is refused;
      // `unassigned` may look, has been given no warehouse, and is served an
      // empty list. Rendering both as a blank screen would state something
      // false to one of them.
      const refused = await request(server())
        .get("/inventory/stock")
        .set("Authorization", await auth("outsider"));
      const empty = await request(server())
        .get("/inventory/stock")
        .set("Authorization", await auth("unassigned"));

      expect(refused.status).toBe(403);
      expect(empty.status).toBe(200);
      expect((empty.body as { items: unknown[] }).items).toHaveLength(0);
    },
    60_000,
  );

  it(
    "a scoped operator sees only its own warehouse, and a scope-all holder sees both",
    async () => {
      const scoped = await request(server())
        .get("/inventory/stock")
        .set("Authorization", await auth("operator"));
      const all = await request(server())
        .get("/inventory/stock")
        .set("Authorization", await auth("manager"));

      /*
       * `location` is a nested object, not a flat `location_id`. The response
       * shape is pinned by `stock-levels-response-shape.spec.ts`, whose
       * top-level key list has no snake_case in it. Reading `row.location_id`
       * here yielded `Number(undefined)` -> `NaN`, and `NaN === locationOne` is
       * false however well the scope behaves -- so this assertion failed for
       * every possible server, which is the one result that proves nothing.
       */
      type Row = { location: { id: number; warehouse: { id: number } | null } | null };
      const scopedItems = (scoped.body as { items: Row[] }).items;
      const allItems = (all.body as { items: Row[] }).items;

      expect(scopedItems).toHaveLength(1);
      expect(allItems).toHaveLength(2);
      // The aggregate must not quietly include a warehouse the reader does not
      // hold -- a total is a disclosure too.
      expect(scopedItems.map((row) => row.location?.id)).toEqual([locationOne]);
      expect(scopedItems.map((row) => row.location?.warehouse?.id)).toEqual([warehouseOne]);
      /*
       * And the scope-all holder must genuinely span both, or "sees only its
       * own" would pass against a server that served warehouse one to everyone.
       */
      expect([...new Set(allItems.map((row) => row.location?.warehouse?.id))].sort()).toEqual(
        [warehouseOne, warehouseTwo].sort(),
      );
    },
    60_000,
  );

  it(
    "filtering to an unheld warehouse yields nothing rather than someone else's rows",
    async () => {
      // Object-id probing: naming a warehouse explicitly must not widen scope.
      const response = await request(server())
        .get("/inventory/stock")
        .query({ warehouseId: String(warehouseTwo) })
        .set("Authorization", await auth("operator"));

      expect(response.status).toBe(200);
      expect((response.body as { items: unknown[] }).items).toHaveLength(0);
    },
    60_000,
  );

  it(
    "a neighbouring tenant's warehouse id discloses nothing",
    async () => {
      // Cross-tenant probing. An empty list rather than a 403, because a 403
      // on another tenant's id confirms that the id exists.
      const neighbourWarehouses = await runInNewTenantTransaction(
        app.app.get<Db>(DRIZZLE),
        otherOrgId,
        async () =>
          app.app
            .get<Db>(DRIZZLE)
            .execute<{ id: number }>(
              sql`SELECT id FROM inv_warehouses WHERE org_id = ${otherOrgId} LIMIT 1`,
            ),
      );
      const foreign = neighbourWarehouses[0]!.id;

      const response = await request(server())
        .get("/inventory/stock")
        .query({ warehouseId: String(foreign) })
        .set("Authorization", await auth("manager"));

      expect(response.status).toBe(200);
      expect((response.body as { items: unknown[] }).items).toHaveLength(0);
    },
    60_000,
  );

  it(
    "a request with no token is refused before any scope is considered",
    async () => {
      const response = await request(server()).get("/inventory/stock");
      expect(response.status).toBe(401);
    },
    60_000,
  );
});
