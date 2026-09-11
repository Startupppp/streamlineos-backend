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
 * INV-101 — the Operations Brief, over HTTP, against the real database.
 *
 * The two properties worth proving here are the ones a unit test cannot: that
 * the route is actually reachable through the guard stack, and that a member
 * without `inventory:ai:read` is refused rather than served an empty
 * brief. "No signals" and "you may not see the signals" must not be the same
 * response.
 */
describe(`${SEEDED_HARNESS} inventory operations brief`, () => {
  let app: SeededE2eApp;

  beforeAll(async () => {
    app = await createSeededE2eApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
  });

  it(
    "serves the brief to a reader and refuses a member without the permission",
    async () => {
      const fixture = await seedOrg(app.seedDb)
        .onPlan("PAID")
        // A6 moved the AI surfaces onto their own key so a metered model
        // endpoint is not gated by the same permission as a deterministic report.
        .addMember("reader", { permissionKeys: ["inventory:reports:read", "inventory:ai:read"] })
        .addMember("outsider")
        .build();

      try {
        // Inventory is not a core module, so ModuleGuard refuses before any
        // permission is considered -- a seeded org that has not enabled it
        // answers 402 to everyone, which would prove nothing about the
        // permission gate this test exists to check.
        const db = app.app.get<Db>(DRIZZLE);
        await runInNewTenantTransaction(db, fixture.orgId, async () => {
          await db.execute(sql`
            INSERT INTO org_modules (org_id, module_key, enabled)
            VALUES (${fixture.orgId}, 'inventory', true)
            ON CONFLICT DO NOTHING`);
        });

        const reader = fixture.members["reader"]!;
        const outsider = fixture.members["outsider"]!;
        const server = app.app.getHttpServer();

        const denied = await request(server)
          .get("/inventory/ai/ops-brief")
          .set(
            "Authorization",
            `Bearer ${await signSeededToken(app, outsider.userId, fixture.orgId)}`,
          );
        expect({ status: denied.status, fixture: fixture.label() }).toMatchObject({
          status: 403,
        });

        const allowed = await request(server)
          .get("/inventory/ai/ops-brief")
          .set(
            "Authorization",
            `Bearer ${await signSeededToken(app, reader.userId, fixture.orgId)}`,
          );
        expect({ status: allowed.status, fixture: fixture.label() }).toMatchObject({
          status: 200,
        });

        // One row per detector, each with a route. A signal a reader cannot
        // open is a dead end, and the whole point of the card is that every
        // figure leads back to the screen that computed it.
        const body = allowed.body as {
          generatedAt: string;
          totalSignals: number;
          signals: Array<{ key: string; href: string; count: number }>;
        };
        expect(body.signals).toHaveLength(6);
        expect(body.signals.every((s) => s.href.startsWith("/inventory/"))).toBe(true);
        expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
        expect(body.totalSignals).toBe(
          body.signals.reduce((sum, s) => sum + s.count, 0),
        );
      } finally {
        await fixture.teardown();
      }
    },
    180_000,
  );
});
