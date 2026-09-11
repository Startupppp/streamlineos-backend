import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import {
  organizationMembers,
  projectMembers,
  roles,
  subscriptions,
} from "src/db/schema";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";
import { EmailProviderService } from "src/modules/email/email.provider";
import { mailEgressTripwire } from "test/helpers/mail-egress-tripwire";

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
      // Two members: this one proves the gate. The mid-test grant below proves invalidation.
      const fixture = await seedOrg(seededApp.seedDb)
        .addMember("alice")
        .addMember("bob", { permissionKeys: ["settings:rbac:manage"] })
        .build();
      try {
        const alice = fixture.members["alice"];
        const bob = fixture.members["bob"];
        if (!alice || !bob) throw new Error("fixture members missing");

        const denied = await request(seededApp.app.getHttpServer())
          .get("/roles")
          .set("Authorization", `Bearer ${await signSeededToken(seededApp, alice.userId, fixture.orgId)}`);
        expect({ status: denied.status, fixture: fixture.label() }).toMatchObject({ status: 403 });

        const allowed = await request(seededApp.app.getHttpServer())
          .get("/roles")
          .set("Authorization", `Bearer ${await signSeededToken(seededApp, bob.userId, fixture.orgId)}`);
        expect({ status: allowed.status, fixture: fixture.label() }).toMatchObject({ status: 200 });
      } finally {
        await fixture.teardown();
      }
    },
    60_000,
  );

  it(
    `${SEEDED_HARNESS} a grant made after the caller was denied takes effect`,
    async () => {
      const fixture = await seedOrg(seededApp.seedDb).addMember("carol").build();
      try {
        const carol = fixture.members["carol"];
        if (!carol) throw new Error("carol not in fixture");
        const token = await signSeededToken(seededApp, carol.userId, fixture.orgId);
        const server = seededApp.app.getHttpServer();

        const denied = await request(server)
          .get("/roles")
          .set("Authorization", `Bearer ${token}`);
        expect({ status: denied.status, fixture: fixture.label() }).toMatchObject({ status: 403 });

        await fixture.grantPermissions("carol", ["settings:rbac:manage"]);

        const allowed = await request(server)
          .get("/roles")
          .set("Authorization", `Bearer ${token}`);
        expect({ status: allowed.status, fixture: fixture.label() }).toMatchObject({ status: 200 });
      } finally {
        await fixture.teardown();
      }
    },
    120_000,
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

        const token = await signSeededToken(seededApp, alice.userId, fixtureA.orgId);
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
    `${SEEDED_HARNESS} standing, plan tier and projects reach the database`,
    async () => {
      const fixture = await seedOrg(seededApp.seedDb)
        .addMember("dana", { standing: "OWNER" })
        .addMember("erin")
        .onPlan("PAID")
        .addProject("apollo", { key: "APOLLO" })
        .addProjectMember("apollo", "erin")
        .build();
      try {
        const dana = fixture.members["dana"];
        const erin = fixture.members["erin"];
        const apollo = fixture.projects["apollo"];
        if (!dana || !erin || !apollo) throw new Error("fixture entries missing");

        const ownerRow = await seededApp.seedDb.query.organizationMembers.findFirst({
          where: eq(organizationMembers.id, dana.membershipId),
          columns: { isOwner: true, role: true },
        });
        expect(ownerRow).toMatchObject({ isOwner: true, role: "OWNER" });

        const planRow = await seededApp.seedDb.query.subscriptions.findFirst({
          where: eq(subscriptions.orgId, fixture.orgId),
          columns: { plan: true },
        });
        expect(planRow).toMatchObject({ plan: "STARTER" });

        const projectMemberRows = await seededApp.seedDb
          .select({ membershipId: projectMembers.membershipId })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, apollo.projectId),
              eq(projectMembers.orgId, fixture.orgId),
            ),
          );
        expect(projectMemberRows).toEqual([{ membershipId: erin.membershipId }]);
      } finally {
        await fixture.teardown();
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

  /**
   * The seeded run cannot mail anyone. Both halves, because either alone fails
   * open.
   *
   * `jest-e2e-seeded.json` loads the real `.env` via `dotenv/config`, so every
   * seeded run holds a live `RESEND_API_KEY` and `EMAIL_PROVIDER=resend`. Two
   * things stop it being used: the harness overrides `EmailProviderService`
   * with an in-memory capture, and `arm-mail-egress.setup.ts` blocks the socket
   * underneath. Neither announces its own absence — delete the override and
   * mail goes out; drop the setup file from `setupFiles` and every suite still
   * passes while the floor is gone. So both are asserted here rather than left
   * to be noticed.
   */
  it(
    `${SEEDED_HARNESS} outbound mail is captured, not sent`,
    async () => {
      /** The container hands out the capture, so no Resend client was built. */
      const bound = seededApp.app.get(EmailProviderService);
      expect(bound).toBe(seededApp.mail);

      /**
       * Not `"none"`: three callers skip the send on that answer, so a capture
       * reporting it would make them no-ops and record nothing.
       */
      expect(bound.getEmailProvider()).not.toBe("none");

      const before = seededApp.mail.count;
      await bound.dispatchEmail({
        to: "harness-self-test@test.invalid",
        subject: "captured, not sent",
        html: "<p>captured</p>",
      });
      expect(seededApp.mail.count).toBe(before + 1);
      expect(seededApp.mail.last()).toMatchObject({
        to: ["harness-self-test@test.invalid"],
        subject: "captured, not sent",
        via: "dispatchEmail",
      });
    },
    30_000,
  );

  it(
    `${SEEDED_HARNESS} the mail egress tripwire is armed`,
    async () => {
      /** Throws when nothing is armed, which is the case this test exists for. */
      const egress = mailEgressTripwire();

      await expect(fetch("https://api.resend.com/emails")).rejects.toThrow(
        /mail egress blocked/,
      );
      expect(egress.attempts).toContain("api.resend.com");
    },
    30_000,
  );
});
