import request from "supertest";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * PROVES:
 *   - An active member with zero explicit permission grants reaches GET /me,
 *     GET /me/profile and GET /mail/accounts at HTTP 200.
 *
 *     /me and /me/profile are @Universal() and bypass PermissionGuard — they prove
 *     that a valid JWT alone is sufficient for universal routes.
 *
 *     /mail/accounts is gated by @RequirePermission("mail:inbox:view") through
 *     PermissionGuard. mail:inbox:view lives in EMPLOYEE_SELF_SERVICE_GRANTS (derived
 *     from ROLE_DEFAULT_PERMISSIONS["MEMBER"]) and is merged before any roleAssignments
 *     row is read. A member with zero roleAssignments rows still carries it and passes
 *     the gate. This is the assertion that would break if EMPLOYEE_SELF_SERVICE_GRANTS
 *     stopped being merged: the response would flip from 200 to 403.
 *
 *   - The same zero-grant member is refused GET /hr/policies at 403, proving that
 *     universal self-service access does not make every route open.
 *
 *   - GET /me always returns the JWT-authenticated user's own userId regardless of
 *     any userId value appended to the query string. The handler reads identity
 *     exclusively from @CurrentUser(), which is populated from the JWT sub — a
 *     client-supplied userId is silently ignored.
 *
 * DOES NOT PROVE:
 *   - That the DENY test would fail if someone deleted @RequirePermission("hr:policies:view")
 *     from the handler entirely. With the hr module disabled, ModuleGuard (a global APP_GUARD)
 *     intercepts the request at 402 Payment Required before PermissionGuard ever evaluates —
 *     the test would stay green whether or not the permission check exists. For this reason
 *     the fixture seeds the hr module via .withModules("hr"), which causes ModuleGuard to
 *     pass and makes PermissionGuard (applied at HrPoliciesController:55 via
 *     @UseGuards(JwtAuthGuard, PermissionGuard)) the gate that produces the 403.
 *   - That mail module routes require no plan-gated module enablement. This is a property
 *     of the module registry (mail: planGated: false, ladder: "universal") and is not
 *     something this file can vary.
 */
describe("[seeded-e2e] Home self-service — universal access and impersonation guard", () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let zeroGrantToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    fixture = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("hr")
      .addMember("zeroGrant")
      .addMember("memberB")
      .build();

    zeroGrantToken = await signSeededToken(
      seeded,
      fixture.members.zeroGrant.userId,
      fixture.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (fixture) await fixture.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("fixture check — two members with no explicit permission grants exist in the same org", () => {
    expect(fixture.members.zeroGrant.userId).toBeTruthy();
    expect(fixture.members.memberB.userId).toBeTruthy();
    expect(fixture.members.zeroGrant.userId).not.toBe(fixture.members.memberB.userId);
    expect(fixture.orgId).toBeTruthy();
    expect(zeroGrantToken).not.toBe("");
  });

  it("ALLOW — GET /me returns 200 for a zero-grant member (Universal route, JWT alone sufficient)", async () => {
    const response = await request(server as never)
      .get("/me")
      .set("Authorization", `Bearer ${zeroGrantToken}`);

    expect(response.status).toBe(200);
  });

  it("ALLOW — GET /me/profile returns 200 for a zero-grant member (Universal route, JWT alone sufficient)", async () => {
    const response = await request(server as never)
      .get("/me/profile")
      .set("Authorization", `Bearer ${zeroGrantToken}`);

    expect(response.status).toBe(200);
  });

  it("ALLOW — GET /mail/accounts returns 200 for a zero-grant member, proving mail:inbox:view is resolved from EMPLOYEE_SELF_SERVICE_GRANTS before any role is read", async () => {
    const response = await request(server as never)
      .get("/mail/accounts")
      .set("Authorization", `Bearer ${zeroGrantToken}`);

    expect(response.status).toBe(200);
  });

  it("DENY — GET /hr/policies returns 403 for a zero-grant member; hr module is enabled so ModuleGuard passes and PermissionGuard refuses on the absent hr:policies:view grant", async () => {
    const response = await request(server as never)
      .get("/hr/policies")
      .set("Authorization", `Bearer ${zeroGrantToken}`);

    expect(response.status).toBe(403);
  });

  it("IMPERSONATION — GET /me returns the JWT user's own userId even when another member's userId is supplied in the query string", async () => {
    const otherUserId = fixture.members.memberB.userId;
    const response = await request(server as never)
      .get(`/me?userId=${otherUserId}`)
      .set("Authorization", `Bearer ${zeroGrantToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ userId: fixture.members.zeroGrant.userId });
    expect(response.body).not.toMatchObject({ userId: otherUserId });
  });

  it("IMPERSONATION — GET /me/profile returns the JWT user's own profile data even when another member's userId is supplied in the query string", async () => {
    const response = await request(server as never)
      .get(`/me/profile?userId=${fixture.members.memberB.userId}`)
      .set("Authorization", `Bearer ${zeroGrantToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: fixture.members.zeroGrant.userId });
    expect(response.body).not.toMatchObject({ id: fixture.members.memberB.userId });
  });
});
