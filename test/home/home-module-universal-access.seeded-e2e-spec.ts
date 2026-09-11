import request from "supertest";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Product rule: every active member keeps Home, /me/* self-service, announcements,
 * people directory and notifications even when their only enabled product is Build
 * or CRM. Handlers use self:* or @Universal(), derive the subject from @CurrentUser(),
 * and carry no @RequireModule on these surfaces.
 *
 * This file asks three questions:
 *
 *   build-only   a zero-grant member in an org with ONLY the build module enabled
 *                reaches GET /me, GET /dashboard/announcements, GET /directory/people
 *                and GET /notifications at 200; none of these carry @RequireModule("build")
 *                and none are 402'd by the global ModuleGuard
 *
 *   crm-only     the same four surfaces return 200 with ONLY the crm module enabled,
 *                proving the property is not build-specific
 *
 *   module gate  GET /dashboard/birthdays carries @RequireModule("hr"); with hr
 *                disabled the global ModuleGuard fires and returns 402, proving the
 *                guard is live and the universal surfaces bypass it by not carrying
 *                @RequireModule rather than by the guard being absent
 *
 *   impersonation GET /me ignores a ?userId query param and returns the JWT-
 *                authenticated caller's own identity; mocked tests prove the handler
 *                reads @CurrentUser(), this file proves it works end-to-end in the
 *                build-only org context (no duplicate from existing spec; same
 *                behaviour is asserted for completeness in a different module context)
 *
 * DOES NOT PROVE: that mail:inbox:view comes from EMPLOYEE_SELF_SERVICE_GRANTS —
 * home-self-service-universal.seeded-e2e-spec.ts covers that explicitly.
 */
describe("[seeded-e2e] Home — universal access with minimal module set", () => {
  let seeded: SeededE2eApp;
  let buildOrg: SeededFixture;
  let crmOrg: SeededFixture;
  let buildToken = "";
  let crmToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    buildOrg = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("build")
      .addMember("member")
      .build();

    crmOrg = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("crm")
      .addMember("member")
      .build();

    buildToken = await signSeededToken(
      seeded,
      buildOrg.members.member.userId,
      buildOrg.orgId,
    );
    crmToken = await signSeededToken(
      seeded,
      crmOrg.members.member.userId,
      crmOrg.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (buildOrg) await buildOrg.teardown();
    if (crmOrg) await crmOrg.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("fixture check — two orgs with distinct module sets and no overlapping members", () => {
    expect(buildOrg.orgId).not.toBe(crmOrg.orgId);
    expect(buildOrg.members.member.userId).not.toBe(crmOrg.members.member.userId);
    expect(buildToken).not.toBe("");
    expect(crmToken).not.toBe("");
  });

  it("ALLOW (build-only) — GET /me returns 200; no @RequireModule on the route", async () => {
    const res = await request(server as never)
      .get("/me")
      .set("Authorization", `Bearer ${buildToken}`);
    expect(res.status).toBe(200);
  });

  it("ALLOW (build-only) — GET /dashboard/announcements returns 200; no @RequireModule on the route", async () => {
    const res = await request(server as never)
      .get("/dashboard/announcements")
      .set("Authorization", `Bearer ${buildToken}`);
    expect(res.status).toBe(200);
  });

  it("ALLOW (build-only) — GET /directory/people returns 200; no @RequireModule on the route", async () => {
    const res = await request(server as never)
      .get("/directory/people")
      .set("Authorization", `Bearer ${buildToken}`);
    expect(res.status).toBe(200);
  });

  it("ALLOW (build-only) — GET /notifications returns 200; no @RequireModule on the route", async () => {
    const res = await request(server as never)
      .get("/notifications")
      .set("Authorization", `Bearer ${buildToken}`);
    expect(res.status).toBe(200);
  });

  it("MODULE-GATE (build-only, hr disabled) — GET /dashboard/birthdays returns 402; @RequireModule('hr') fires via global ModuleGuard", async () => {
    const res = await request(server as never)
      .get("/dashboard/birthdays")
      .set("Authorization", `Bearer ${buildToken}`);
    expect(res.status).toBe(402);
  });

  it("ALLOW (crm-only) — GET /me returns 200; universal access is not module-specific", async () => {
    const res = await request(server as never)
      .get("/me")
      .set("Authorization", `Bearer ${crmToken}`);
    expect(res.status).toBe(200);
  });

  it("ALLOW (crm-only) — GET /dashboard/announcements returns 200", async () => {
    const res = await request(server as never)
      .get("/dashboard/announcements")
      .set("Authorization", `Bearer ${crmToken}`);
    expect(res.status).toBe(200);
  });

  it("ALLOW (crm-only) — GET /directory/people returns 200", async () => {
    const res = await request(server as never)
      .get("/directory/people")
      .set("Authorization", `Bearer ${crmToken}`);
    expect(res.status).toBe(200);
  });

  it("ALLOW (crm-only) — GET /notifications returns 200", async () => {
    const res = await request(server as never)
      .get("/notifications")
      .set("Authorization", `Bearer ${crmToken}`);
    expect(res.status).toBe(200);
  });

  it("IMPERSONATION (build-only) — GET /me returns the JWT user's own userId even with ?userId=<other> in the query string", async () => {
    const otherId = crmOrg.members.member.userId;
    const res = await request(server as never)
      .get(`/me?userId=${otherId}`)
      .set("Authorization", `Bearer ${buildToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: buildOrg.members.member.userId });
    expect(res.body).not.toMatchObject({ userId: otherId });
  });
});
