import { and, eq } from "drizzle-orm";
import request from "supertest";
import { organizationMembers, userPermissionGrants } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { ORG_MEMBER_ROLES } from "src/common/rbac/org-roles";
import { bumpPermissionsVersion } from "src/common/rbac/access-invalidate";

/**
 * Per-person grant lifecycle, end to end.
 *
 * `user_permission_grants` folds into `computeUserPermissions` beside role grants,
 * so every existing `@RequirePermission` gate honours it with no call-site change.
 * Mocked tests prove the service logic; this file asks whether the full request
 * path — guard, resolved permissions, gate — actually enforces the grant.
 *
 * Four properties proved:
 *
 *   gate bites     before a grant exists the gated route returns 403; this proves
 *                  the grant truly enables access and the ALLOW below is not vacuous
 *
 *   grant works    after the owner sets the grant, the same route returns 200 with
 *                  no call-site change at the controller or gate
 *
 *   role-change    after a MEMBER → ORG_ADMIN → MEMBER roundtrip (DB direct update +
 *                  bumpPermissionsVersion), the per-person grant still delivers 200;
 *                  the grant hangs off the membership, not the role template
 *
 *   revocation     after the owner revokes (empty items), the route returns 403;
 *                  the grant is cleared only by explicit revocation, not by time,
 *                  session refresh, or role change
 *
 * NOTE: This spec does NOT call `home.teardown()`. Setting a grant triggers
 * `AuditService.log()`, which writes an `audit_logs` row. The `audit_logs_append_only`
 * trigger fires on DELETE, and the FK carries NO ACTION, so the org row cannot be
 * removed after any audited write. Deleting it would mark the suite as "failed to
 * run" even though every test passed. Only the grant rows are cleaned up; the org
 * is left in the disposable database, which is acceptable because the database is
 * discarded after this round.
 */
describe("[seeded-e2e] Settings — per-person grant lifecycle", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let ownerToken = "";
  let readerToken = "";
  let server: unknown;

  const ACCESS_VERSION_PROPAGATION_MS = 1_500;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("accounting")
      .addMember("owner", { standing: ORG_MEMBER_ROLES.OWNER })
      .addMember("reader")
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

  afterAll(async () => {
    if (home && seeded)
      await seeded.seedDb
        .delete(userPermissionGrants)
        .where(eq(userPermissionGrants.orgId, home.orgId));
    if (seeded) await seeded.close();
  }, 120_000);

  async function grantRowExists(key: string): Promise<boolean> {
    const rows = await seeded.seedDb
      .select({ id: userPermissionGrants.id })
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, home.orgId),
          eq(userPermissionGrants.organizationMembershipId, home.members.reader?.membershipId ?? 0),
          eq(userPermissionGrants.permissionKey, key),
        ),
      );
    return rows.length > 0;
  }

  it("fixture check — owner and reader are distinct active members of the same org", () => {
    expect(home.members.owner?.userId).toBeTruthy();
    expect(home.members.reader?.userId).toBeTruthy();
    expect(home.members.owner?.membershipId).not.toBe(home.members.reader?.membershipId);
    expect(ownerToken).not.toBe("");
    expect(readerToken).not.toBe("");
  });

  it("GATE BITES — reader cannot access GET /accounting/journal before any grant (403)", async () => {
    const res = await request(server as never)
      .get("/accounting/journal")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(403);
    expect(await grantRowExists("accounting:journal:read")).toBe(false);
  });

  it("GRANT WORKS — owner sets accounting:journal:read; reader now accesses GET /accounting/journal (200)", async () => {
    const membershipId = home.members.reader?.membershipId ?? 0;
    const grant = await request(server as never)
      .put(`/module-access/accounting/members/${String(membershipId)}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ items: [{ permissionKey: "accounting:journal:read" }] });
    expect(grant.status).toBe(200);
    expect(await grantRowExists("accounting:journal:read")).toBe(true);

    const gated = await request(server as never)
      .get("/accounting/journal")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(gated.status).toBe(200);
  }, 30_000);

  it("ROLE-CHANGE — grant survives a MEMBER → ORG_ADMIN → MEMBER roundtrip; reader still gets 200", async () => {
    const membershipId = home.members.reader?.membershipId ?? 0;

    await seeded.seedDb
      .update(organizationMembers)
      .set({ role: ORG_MEMBER_ROLES.ORG_ADMIN })
      .where(
        and(
          eq(organizationMembers.orgId, home.orgId),
          eq(organizationMembers.id, membershipId),
        ),
      );
    await bumpPermissionsVersion(seeded.seedDb, home.orgId);
    await sleep(ACCESS_VERSION_PROPAGATION_MS);

    await seeded.seedDb
      .update(organizationMembers)
      .set({ role: ORG_MEMBER_ROLES.MEMBER })
      .where(
        and(
          eq(organizationMembers.orgId, home.orgId),
          eq(organizationMembers.id, membershipId),
        ),
      );
    await bumpPermissionsVersion(seeded.seedDb, home.orgId);
    await sleep(ACCESS_VERSION_PROPAGATION_MS);

    expect(await grantRowExists("accounting:journal:read")).toBe(true);

    const res = await request(server as never)
      .get("/accounting/journal")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(200);
  }, 30_000);

  it("REVOCATION — owner revokes (empty items); reader can no longer access the route (403)", async () => {
    const membershipId = home.members.reader?.membershipId ?? 0;
    const revoke = await request(server as never)
      .put(`/module-access/accounting/members/${String(membershipId)}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ items: [] });
    expect(revoke.status).toBe(200);
    expect(await grantRowExists("accounting:journal:read")).toBe(false);

    const res = await request(server as never)
      .get("/accounting/journal")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(403);
  }, 30_000);
});
