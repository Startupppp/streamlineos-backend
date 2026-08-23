import request from "supertest";
import { sql } from "drizzle-orm";
import { roles } from "src/db/schema";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

// Bounded suite runtime: ≤ 120 s per test, expected total ≤ 90 s.

describe(`${SEEDED_HARNESS} harness self-tests`, () => {
  let seededApp: SeededE2eApp;

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();
  }, 120_000);

  afterAll(async () => {
    await seededApp.close();
  });

  it(
    `${SEEDED_HARNESS} permission absent → 403; permission granted → 200`,
    async () => {
      const fixture = await seedOrg(seededApp.seedDb).addMember("alice").build();
      console.log(`fixture: ${fixture.label()}`);
      try {
        const alice = fixture.members["alice"];
        if (!alice) throw new Error("alice not in fixture");

        const token = await signSeededToken(alice.userId, fixture.orgId);

        const denied = await request(seededApp.app.getHttpServer())
          .get("/roles")
          .set("Authorization", `Bearer ${token}`);
        expect({ status: denied.status, fixture: fixture.label() }).toMatchObject({ status: 403 });

        await fixture.grantPermissions("alice", ["settings:rbac:manage"]);

        const allowed = await request(seededApp.app.getHttpServer())
          .get("/roles")
          .set("Authorization", `Bearer ${token}`);
        expect({ status: allowed.status, fixture: fixture.label() }).toMatchObject({ status: 200 });
      } finally {
        await fixture.teardown();
      }
    },
    60_000,
  );

  it(
    `${SEEDED_HARNESS} org B resource requested by org A member → 404 not 403`,
    async () => {
      const fixtureA = await seedOrg(seededApp.seedDb)
        .addMember("alice", { permissionKeys: ["settings:rbac:manage"] })
        .build();
      const fixtureB = await seedOrg(seededApp.seedDb)
        .addMember("bob", { permissionKeys: ["settings:rbac:manage"] })
        .build();
      console.log(`fixture A: ${fixtureA.label()}`);
      console.log(`fixture B: ${fixtureB.label()}`);
      try {
        const alice = fixtureA.members["alice"];
        if (!alice) throw new Error("alice not in fixtureA");

        const orgBRoles = await seededApp.seedDb.execute(
          sql`SELECT id FROM roles WHERE org_id = ${fixtureB.orgId} LIMIT 1`,
        );
        const orgBRoleId: unknown = orgBRoles[0]?.["id"];
        if (typeof orgBRoleId !== "number" && typeof orgBRoleId !== "string")
          throw new Error(`No role found in org B (${fixtureB.orgId}); did the seed not create one?`);

        const token = await signSeededToken(alice.userId, fixtureA.orgId);
        const res = await request(seededApp.app.getHttpServer())
          .get(`/roles/${String(orgBRoleId)}`)
          .set("Authorization", `Bearer ${token}`);
        expect({
          status: res.status,
          fixtureA: fixtureA.label(),
          fixtureB: fixtureB.label(),
        }).toMatchObject({ status: 404 });
      } finally {
        await Promise.all([fixtureA.teardown(), fixtureB.teardown()]);
      }
    },
    60_000,
  );

  it(
    `${SEEDED_HARNESS} direct query without tenant GUC is denied by RLS`,
    async () => {
      const db = seededApp.app.get<Db>(DRIZZLE);
      // Drizzle wraps the driver error, so 42501 rides on the cause, not the top level.
      const denied = await db
        .select({ id: roles.id })
        .from(roles)
        .limit(1)
        .then(
          () => null,
          (error: unknown) => error,
        );
      const cause = denied instanceof Error ? denied.cause : denied;
      expect(cause).toMatchObject({ code: "42501" });
    },
    30_000,
  );

  it(
    `${SEEDED_HARNESS} app connection does not bypass RLS`,
    async () => {
      const db = seededApp.app.get<Db>(DRIZZLE);
      const rows = await db.execute(
        sql`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      const row = rows[0];
      expect(row).toBeDefined();
      expect({
        rolbypassrls: row?.["rolbypassrls"],
        message: "APP_DATABASE_URL must point to a non-owner role (NOBYPASSRLS). Set APP_DATABASE_URL=<app_role_url>.",
      }).toMatchObject({ rolbypassrls: false });
    },
    30_000,
  );
});
