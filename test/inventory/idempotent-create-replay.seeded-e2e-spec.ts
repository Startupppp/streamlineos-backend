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
 * T24 — a create a client may retry.
 *
 * T17 classified all 214 mutating inventory routes and found forty that a retry
 * duplicates: a client whose first attempt timed out, or an operator who pressed
 * the button twice, got two products, two warehouses, two webhook subscriptions
 * delivering every event twice. It bounded the number and left the fix alone.
 *
 * T23 then found the census was reading only `@IdempotencyKey()` and could not
 * see `@Idempotent(...)` at all, so three of the forty were already fenced and
 * had been given hand-written reasons describing a duplicate that cannot happen.
 * Thirty-seven were real, and this spec is the proof that they no longer are.
 *
 * The seam is HTTP, and it has to be: the fence is a global interceptor, so a
 * service-level call would prove the row arithmetic and nothing at all about
 * what a retrying client is told. Three routes are exercised rather than
 * thirty-seven — the coverage that every one of the thirty-seven carries the
 * decorator is asserted from source by `inventory-idempotency-coverage`, and
 * what a spec adds is proof that the mechanism that decorator names actually
 * behaves. So these cover the classes of risk (master data, a warehouse the
 * whole module hangs off, a vendor every purchase order points at) rather than
 * the count.
 *
 * What removing a fence actually does, measured rather than assumed — because
 * T17's recorded reason for all forty was "a retry raises a second <document>",
 * and for a good half of them that is the wrong failure. Two modes:
 *
 *   1. The table carries a tenant-scoped unique index on a USER-supplied natural
 *      key — `inv_products(org_id, sku)`, `inv_warehouses(org_id, code)`,
 *      `inv_vendors(org_id, code)`, `inv_carriers`, `inv_channels`. A retry
 *      sends the same key, hits the index, and gets **409 "already exists"**.
 *      No duplicate row; instead a client that in fact succeeded is told it
 *      failed. That is the PEND-IDEM shape exactly, and it is what removing the
 *      product fence produces — verified, not reasoned.
 *   2. The number is SERVER-generated, or there is no natural key at all —
 *      `inv_sales_orders(so_number)`, `inv_shipments`, `inv_loads`,
 *      `inv_packages`, `*_returns(return_number)`, `inv_cycle_counts`,
 *      `inv_webhooks` (unique on id + org_id only). The retry mints a fresh
 *      number and the second document is real.
 *
 * The fence is the right fix for both, which is why the reasons being wrong did
 * not make the work wrong. But it means "37 routes duplicate" overstated mode 1
 * and the count was never the interesting number.
 *
 * Each asserts three things, because the fence makes three promises and two of
 * them are the ones that rot silently:
 *   - same key, same body   → the FIRST response, replayed, and one row
 *   - same key, other body  → 422, rather than quietly writing the second body
 *   - a fresh key           → a genuinely new document, so the fence has not
 *                             turned the endpoint into a singleton
 */
interface Scene {
  orgId: string;
  keeperId: string;
}

describe(`${SEEDED_HARNESS} a create a client may retry`, () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let keeperToken = "";
  let teardown: () => Promise<void>;

  const server = () => app.app.getHttpServer();
  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:warehouses:manage",
          "inventory:products:create",
          "inventory:products:read",
          "inventory:vendors:manage",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    scene = { orgId: seeded.orgId, keeperId: seeded.members["keeper"]!.userId };
    await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      await db().execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${seeded.orgId}, 'inventory', true) ON CONFLICT DO NOTHING`);
    });
    keeperToken = `Bearer ${await signSeededToken(scene.keeperId, scene.orgId)}`;
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  /**
   * Surfaces the body when a status assertion fails. The sibling replay spec lost
   * time to a bare "expected <300, received 402" that turned out to be a fixture
   * gap (MODULE_NOT_ENABLED), not the defect under test.
   */
  const expectAccepted = (res: { status: number; body: unknown }) => {
    if (res.status >= 300)
      throw new Error(`expected a 2xx, got ${res.status}: ${JSON.stringify(res.body)}`);
  };

  const countWhere = async (table: string, column: string, value: string) => {
    const [row] = await asTenant(() =>
      db().execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}
            WHERE org_id = ${scene.orgId} AND ${sql.raw(column)} = ${value}`,
      ),
    );
    return Number(row?.n ?? "0");
  };

  /**
   * The whole contract for one route, in one place. `mutate` produces a body that
   * differs from `body` in a way the route's own validation accepts, so the 422
   * comes from the fence rather than from Zod.
   */
  const provesTheFence = async (opts: {
    path: string;
    body: Record<string, unknown>;
    otherBody: Record<string, unknown>;
    freshBody: Record<string, unknown>;
    table: string;
    column: string;
    value: string;
  }) => {
    const key = randomUUID();

    const first = await request(server())
      .post(opts.path)
      .set("Authorization", keeperToken)
      .set("Idempotency-Key", key)
      .send(opts.body);
    expectAccepted(first);

    const replay = await request(server())
      .post(opts.path)
      .set("Authorization", keeperToken)
      .set("Idempotency-Key", key)
      .send(opts.body);
    expectAccepted(replay);

    // The retry is answered, not re-executed.
    expect(replay.body).toEqual(first.body);
    expect(await countWhere(opts.table, opts.column, opts.value)).toBe(1);

    // The same key with a different body is refused rather than silently
    // writing the second body or replaying an answer that does not match it.
    const mismatch = await request(server())
      .post(opts.path)
      .set("Authorization", keeperToken)
      .set("Idempotency-Key", key)
      .send(opts.otherBody);
    expect(mismatch.status).toBe(422);

    // And the fence has not turned a create into a singleton: a new intent,
    // with a new key, still creates.
    const fresh = await request(server())
      .post(opts.path)
      .set("Authorization", keeperToken)
      .set("Idempotency-Key", randomUUID())
      .send(opts.freshBody);
    expectAccepted(fresh);
    expect(await countWhere(opts.table, opts.column, opts.value)).toBe(1);
  };

  it("replays a product create instead of raising a second product", async () => {
    const tag = randomUUID().slice(0, 8).toUpperCase();
    await provesTheFence({
      path: "/inventory/products",
      body: { name: `Retryable ${tag}`, sku: `RC-${tag}` },
      otherBody: { name: `Different ${tag}`, sku: `RC-${tag}-X` },
      freshBody: { name: `Second ${tag}`, sku: `RC-${tag}-2` },
      table: "inv_products",
      column: "sku",
      value: `RC-${tag}`,
    });
  }, 120_000);

  it("replays a warehouse create instead of raising a second warehouse", async () => {
    const tag = randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, "");
    await provesTheFence({
      path: "/inventory/warehouses",
      body: { name: `Retryable ${tag}`, code: `W-${tag}` },
      otherBody: { name: `Different ${tag}`, code: `W-${tag}-X` },
      freshBody: { name: `Second ${tag}`, code: `W2-${tag}` },
      table: "inv_warehouses",
      column: "code",
      value: `W-${tag}`,
    });
  }, 120_000);

  it("replays a vendor create instead of raising a second vendor", async () => {
    const tag = randomUUID().slice(0, 8).toUpperCase();
    await provesTheFence({
      path: "/inventory/vendors",
      body: { name: `Retryable vendor ${tag}`, code: `V-${tag}` },
      otherBody: { name: `Different vendor ${tag}`, code: `V-${tag}-X` },
      freshBody: { name: `Second vendor ${tag}`, code: `V2-${tag}` },
      table: "inv_vendors",
      column: "code",
      value: `V-${tag}`,
    });
  }, 120_000);

  it("refuses a fenced create that arrives with no key at all", async () => {
    // The cost of the fence, stated rather than discovered: `@Idempotent` makes
    // the header required, so a keyless caller now gets a 400. The browser is
    // safe because `api-client.ts` mints one on every mutating request — which
    // is also why the fence does nothing for a real double-submit until the key
    // is scoped to the intent (T25). A non-browser client that sent no header
    // is a genuine break, and this asserts the shape of it rather than leaving
    // it to be found in production.
    const res = await request(server())
      .post("/inventory/products")
      .set("Authorization", keeperToken)
      .send({ name: "Keyless", sku: `KL-${randomUUID().slice(0, 8).toUpperCase()}` });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Idempotency-Key");
  }, 120_000);
});
