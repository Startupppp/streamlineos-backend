import { and, eq } from "drizzle-orm";
import request from "supertest";
import { userPermissionGrants } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import {
  seedOrg,
  type SeededFixture,
} from "test/helpers/seed-builder";
import { ORG_MEMBER_ROLES } from "src/common/rbac/org-roles";

/**
 * Privilege-escalation guards exercised against a real Postgres. Every mocked
 * RBAC test stops at "the service received a ForbiddenException"; this file
 * asks whether the HTTP layer actually returns the correct refusal status, and
 * whether the user_permission_grants table is empty after each refusal — a
 * mocked test cannot assert the latter.
 *
 * The four properties proved here:
 *
 *   no authority   a plain MEMBER lacking module management standing cannot
 *                  reach the grants endpoint at all (403 from assertModuleAccess)
 *   cross-module   an org owner attempting to grant a key that belongs to a
 *                  DIFFERENT module via the accounting route is refused (400 —
 *                  the per-module catalog filter in UserPermissionGrantsService
 *                  fires before assertPermissionsGrantable is reached) and no
 *                  row is written; removing the catalog filter would turn this
 *                  red because the owner bypasses assertPermissionsGrantable
 *   billing block  an org owner attempting to grant a billing: key via the
 *                  accounting module route is refused (400 — same catalog filter,
 *                  because billing keys are not in the accounting catalog) and
 *                  no row is written
 *   self-grant     an org owner targeting their own membershipId is refused
 *                  (403 from the explicit self-check in UserPermissionGrantsService
 *                  at target.userId === actor.userId) and no row is written
 *
 * WHY NOT "not held". CLAUDE.md §5 states "org admin implies module admin." The
 * same standing that gives an actor the right to call this endpoint (module
 * management authority) also expands their effective permission set to include the
 * full accounting namespace — so assertPermissionsGrantable's notHeld filter never
 * fires for any in-module key for any actor who can reach this point. Testing 403
 * for that case asserts the opposite of what the system is designed to do.
 *
 * WHAT THIS FILE DOES *NOT* PROVE. The cross-module and billing tests prove the
 * catalog-filter defence (400 BadRequest), not assertPermissionsGrantable itself:
 * assertPermissionsGrantable is only reached after the catalog filter, which
 * already blocks those keys. The self-grant test IS attributable directly to the
 * explicit self-check (line ~107 of user-permission-grants.service.ts) — removing
 * that line turns the self-grant case red here and nowhere else. Cross-tenant
 * isolation of the grants route is a separate property not covered here.
 */
describe("[seeded-e2e] Settings RBAC — privilege escalation refused", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let ownerToken = "";
  let readerToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("accounting")
      .addMember("owner", { standing: ORG_MEMBER_ROLES.OWNER })
      .addMember("reader", { permissionKeys: ["accounting:journal:read"] })
      .build();

    ownerToken = await signSeededToken(
      seeded,
      home.members.owner?.userId ?? "",
      home.orgId,
    );
    readerToken = await signSeededToken(
      seeded,
      home.members.reader?.userId ?? "",
      home.orgId,
    );
  }, 180_000);

  // This spec deliberately does NOT call `home.teardown()`, and the reason is a property of the
  // system rather than an oversight. Granting a permission is a sensitive action, so the route
  // writes an `audit_logs` row. `audit_logs_org_id_organizations_id_fk` carries NO ACTION, and the
  // `audit_logs_append_only` trigger raises on every DELETE — its `app.audit_log_detachment` escape
  // covers `TG_OP = 'UPDATE'` only. Both facts were measured, not assumed: the org delete was
  // attempted inside a rolled-back transaction, and the audit delete was attempted as the owner.
  // So an organisation that has performed an audited action cannot be hard-deleted by anyone, and
  // calling teardown() here would throw, marking the suite "failed to run" while all of its tests
  // had in fact passed. The grants are removed because they are the subject of the assertions; the
  // organisation is left behind, which is acceptable only because this database is disposable.
  afterAll(async () => {
    if (home && seeded)
      await seeded.seedDb
        .delete(userPermissionGrants)
        .where(eq(userPermissionGrants.orgId, home.orgId));
    if (seeded) await seeded.close();
  }, 120_000);

  async function grantRowExists(membershipId: number, key: string): Promise<boolean> {
    const rows = await seeded.seedDb
      .select({ id: userPermissionGrants.id })
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, home.orgId),
          eq(userPermissionGrants.organizationMembershipId, membershipId),
          eq(userPermissionGrants.permissionKey, key),
        ),
      );
    return rows.length > 0;
  }

  it("fixture check — owner and reader are distinct members of the same org", () => {
    expect(home.members.owner?.membershipId).toBeDefined();
    expect(home.members.reader?.membershipId).toBeDefined();
    expect(home.members.owner?.membershipId).not.toBe(home.members.reader?.membershipId);
    expect(home.members.owner?.userId).not.toBe(home.members.reader?.userId);
    expect(home.orgId).toBeTruthy();
  });

  it("ALLOW — owner sets an empty grant list for reader", async () => {
    const readerMembershipId = home.members.reader?.membershipId ?? 0;
    const response = await request(server as never)
      .put(`/module-access/accounting/members/${String(readerMembershipId)}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ items: [] });

    expect(response.status).toBe(200);
  });

  it("DENY (no authority) — reader cannot call the grants endpoint, 403 from assertModuleAccess", async () => {
    const ownerMembershipId = home.members.owner?.membershipId ?? 0;
    const response = await request(server as never)
      .put(`/module-access/accounting/members/${String(ownerMembershipId)}/grants`)
      .set("Authorization", `Bearer ${readerToken}`)
      .send({ items: [{ permissionKey: "accounting:journal:read" }] });

    expect(response.status).toBe(403);
    expect(
      await grantRowExists(ownerMembershipId, "accounting:journal:read"),
    ).toBe(false);
  });

  it("DENY (cross-module) — owner is refused a key from another module via the accounting route, 400 from catalog filter, no row written", async () => {
    const readerMembershipId = home.members.reader?.membershipId ?? 0;
    const response = await request(server as never)
      .put(`/module-access/accounting/members/${String(readerMembershipId)}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ items: [{ permissionKey: "hr:policies:view" }] });

    expect(response.status).toBe(400);
    expect(
      await grantRowExists(readerMembershipId, "hr:policies:view"),
    ).toBe(false);
  });

  it("DENY (billing namespace) — owner is refused a billing: key via the accounting route, 400 from catalog filter, no row written", async () => {
    const readerMembershipId = home.members.reader?.membershipId ?? 0;
    const response = await request(server as never)
      .put(`/module-access/accounting/members/${String(readerMembershipId)}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ items: [{ permissionKey: "billing:subscription:view" }] });

    expect(response.status).toBe(400);
    expect(
      await grantRowExists(readerMembershipId, "billing:subscription:view"),
    ).toBe(false);
  });

  it("DENY (self-grant) — owner cannot grant to themselves, 403 from self-check, no row written", async () => {
    const ownerMembershipId = home.members.owner?.membershipId ?? 0;
    const response = await request(server as never)
      .put(`/module-access/accounting/members/${String(ownerMembershipId)}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ items: [{ permissionKey: "accounting:journal:read" }] });

    expect(response.status).toBe(403);
    expect(
      await grantRowExists(ownerMembershipId, "accounting:journal:read"),
    ).toBe(false);
  });

  it("ALLOW — owner grants accounting:journal:read to reader and the row is written", async () => {
    const readerMembershipId = home.members.reader?.membershipId ?? 0;
    const response = await request(server as never)
      .put(`/module-access/accounting/members/${String(readerMembershipId)}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ items: [{ permissionKey: "accounting:journal:read" }] });

    expect(response.status).toBe(200);
    expect(
      await grantRowExists(readerMembershipId, "accounting:journal:read"),
    ).toBe(true);
  });
});
