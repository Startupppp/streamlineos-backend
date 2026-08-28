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
 * A7 — warehouse assignment, over HTTP.
 *
 * The loop that matters is grant → see → revoke → cannot see. Everything else
 * about the screen is presentation; this is the part that decides whether a
 * warehouse-scoped operator can reach a warehouse they hold no scope on, and it
 * is the part a type-check cannot say anything about.
 */
describe(`${SEEDED_HARNESS} warehouse assignment`, () => {
  let app: SeededE2eApp;
  let orgId = "";
  let adminId = "";
  let operatorId = "";
  let warehouseId = 0;
  const teardowns: Array<() => Promise<void>> = [];

  const server = () => app.app.getHttpServer();
  const auth = async (userId: string) => `Bearer ${await signSeededToken(userId, orgId)}`;

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const fixture = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("admin", {
        permissionKeys: ["inventory:warehouses:manage", "inventory:warehouses:read"],
      })
      // Deliberately no scope-all: this member sees only what they are assigned.
      .addMember("operator", { permissionKeys: ["inventory:warehouses:read"] })
      .build();
    teardowns.push(() => fixture.teardown());
    orgId = fixture.orgId;
    adminId = fixture.members["admin"]!.userId;
    operatorId = fixture.members["operator"]!.userId;

    const db = app.app.get<Db>(DRIZZLE);
    await runInNewTenantTransaction(db, orgId, async () => {
      await db.execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${orgId}, 'inventory', true) ON CONFLICT DO NOTHING`);
    });
    const tag = randomUUID().slice(0, 6);
    warehouseId = await runInNewTenantTransaction(db, orgId, async () => {
      const [row] = await db.execute<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, 'Assigned', ${`AS${tag}`}, ${adminId}) RETURNING id`);
      return row!.id;
    });
  }, 240_000);

  afterAll(async () => {
    for (const drop of teardowns) await drop().catch(() => undefined);
    await app.close();
  });

  it("hides a warehouse the operator holds no scope on", async () => {
    // 404 rather than 403: a 403 on a warehouse id confirms it exists, which
    // turns the endpoint into an existence oracle.
    const response = await request(server())
      .get(`/inventory/warehouses/${warehouseId}`)
      .set("Authorization", await auth(operatorId));
    expect(response.status).toBe(404);
  });

  it("grants scope, and the operator can then see it", async () => {
    const granted = await request(server())
      .post(`/inventory/warehouses/${warehouseId}/users`)
      .set("Authorization", await auth(adminId))
      .send({ userId: operatorId });
    expect([200, 201]).toContain(granted.status);

    const response = await request(server())
      .get(`/inventory/warehouses/${warehouseId}`)
      .set("Authorization", await auth(operatorId));
    expect(response.status).toBe(200);
  });

  it("grants idempotently rather than stacking assignments", async () => {
    // A double-click must not produce two rows and two audit entries.
    await request(server())
      .post(`/inventory/warehouses/${warehouseId}/users`)
      .set("Authorization", await auth(adminId))
      .send({ userId: operatorId });

    const [row] = await runInNewTenantTransaction(
      app.app.get<Db>(DRIZZLE),
      orgId,
      async () =>
        app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM inv_user_warehouses
          WHERE org_id = ${orgId} AND user_id = ${operatorId}
            AND warehouse_id = ${warehouseId}`),
    );
    expect(row!.n).toBe(1);
  });

  it("lists who holds scope", async () => {
    const response = await request(server())
      .get(`/inventory/warehouses/${warehouseId}/users`)
      .set("Authorization", await auth(adminId));
    expect(response.status).toBe(200);
    const body = response.body as { items?: Array<{ userId?: string }> };
    expect(JSON.stringify(body)).toContain(operatorId);
  });

  it("revokes scope, and the warehouse disappears again", async () => {
    const revoked = await request(server())
      .delete(`/inventory/warehouses/${warehouseId}/users/${operatorId}`)
      .set("Authorization", await auth(adminId));
    expect([200, 204]).toContain(revoked.status);

    const response = await request(server())
      .get(`/inventory/warehouses/${warehouseId}`)
      .set("Authorization", await auth(operatorId));
    expect(response.status).toBe(404);
  });

  it("refuses to grant scope to somebody outside the organisation", async () => {
    // The grantee is named in the payload, so it is the obvious way to reach
    // across a tenant boundary.
    const response = await request(server())
      .post(`/inventory/warehouses/${warehouseId}/users`)
      .set("Authorization", await auth(adminId))
      .send({ userId: randomUUID() });
    expect(response.status).toBe(404);
  });

  it("refuses an operator who tries to grant themselves scope", async () => {
    const response = await request(server())
      .post(`/inventory/warehouses/${warehouseId}/users`)
      .set("Authorization", await auth(operatorId))
      .send({ userId: operatorId });
    expect(response.status).toBe(403);
  });
});
