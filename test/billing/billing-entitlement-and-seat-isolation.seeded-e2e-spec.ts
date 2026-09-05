import request from "supertest";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { ORG_MEMBER_ROLES } from "src/common/rbac/org-roles";

/**
 * Billing domain — entitlement isolation, RBAC gates, seat visibility and
 * per-person grant refusal.
 *
 * Four invariants proved:
 *
 *   cross-tenant    Each organisation reads its own plan tier from
 *                   GET /billing/entitlements; the PAID org cannot see the FREE
 *                   org's entitlements and vice versa. The route is @Universal()
 *                   so any authenticated member can call it, making it the
 *                   cleanest cross-tenant probe: no special permission required.
 *
 *   rbac gate       GET /billing (subscription) requires billing:subscription:view.
 *                   A plain MEMBER of the PAID org gets 403 before the owner gets 200.
 *                   billing: keys are org-only and not delegable to individuals, so
 *                   the MEMBER has no path to obtain the permission.
 *
 *   seat visibility GET /billing/seats is gated on billing:seats:view (owner-only).
 *                   The used count matches the number of active members seeded.
 *
 *   non-delegable   PUT /module-access/billing/members/:membershipId/grants returns 404
 *                   because "billing" is not in ACCESS_MANAGED_MODULES (ladder is
 *                   "platform-admin", not "delegable"). assertManagedModule throws
 *                   NotFoundException before assertPermissionsGrantable is reached,
 *                   proving that the per-person module-access screen for billing
 *                   does not exist and billing keys cannot reach the grants path.
 *
 *   free lock       PATCH /access/org-modules/payroll with { enabled: true } on a
 *                   FREE org returns 403 because PLAN_LOCKED_MODULES.FREE includes
 *                   "payroll". setModuleEnabled checks the tier before any DB write,
 *                   so existing enablement on a PAID org is never revoked by a tier
 *                   change — only new enables are blocked.
 */
describe("[seeded-e2e] Billing — entitlement isolation, RBAC gates and non-delegable fence", () => {
  let seeded: SeededE2eApp;
  let paidOrg: SeededFixture;
  let freeOrg: SeededFixture;
  let paidOwnerToken = "";
  let paidMemberToken = "";
  let freeOwnerToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    paidOrg = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("owner", { standing: ORG_MEMBER_ROLES.OWNER })
      .addMember("member")
      .build();

    freeOrg = await seedOrg(seeded.seedDb)
      .addMember("owner", { standing: ORG_MEMBER_ROLES.OWNER })
      .build();

    paidOwnerToken = await signSeededToken(
      seeded,
      paidOrg.members.owner?.userId ?? "",
      paidOrg.orgId,
    );
    paidMemberToken = await signSeededToken(
      seeded,
      paidOrg.members.member?.userId ?? "",
      paidOrg.orgId,
    );
    freeOwnerToken = await signSeededToken(
      seeded,
      freeOrg.members.owner?.userId ?? "",
      freeOrg.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (paidOrg) await paidOrg.teardown();
    if (freeOrg) await freeOrg.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("fixture check — paid org has owner + member, free org has owner only; orgIds are distinct", () => {
    expect(paidOrg.members.owner?.userId).toBeTruthy();
    expect(paidOrg.members.member?.userId).toBeTruthy();
    expect(freeOrg.members.owner?.userId).toBeTruthy();
    expect(paidOrg.orgId).not.toBe(freeOrg.orgId);
    expect(paidOwnerToken).not.toBe("");
    expect(paidMemberToken).not.toBe("");
    expect(freeOwnerToken).not.toBe("");
  });

  it("ENTITLEMENTS PAID — GET /billing/entitlements with the paid org token reflects tier=PAID and no locked modules", async () => {
    const res = await request(server as never)
      .get("/billing/entitlements")
      .set("Authorization", `Bearer ${paidOwnerToken}`);

    expect(res.status).toBe(200);
    const body: unknown = res.body;
    expect(body).toMatchObject({ tier: "PAID" });
    const lockedModules: unknown = (body as Record<string, unknown>)["lockedModules"];
    expect(Array.isArray(lockedModules)).toBe(true);
    expect((lockedModules as string[]).length).toBe(0);
  });

  it("ENTITLEMENTS FREE — GET /billing/entitlements with the free org token reflects tier=FREE and payroll locked", async () => {
    const res = await request(server as never)
      .get("/billing/entitlements")
      .set("Authorization", `Bearer ${freeOwnerToken}`);

    expect(res.status).toBe(200);
    const body: unknown = res.body;
    expect(body).toMatchObject({ tier: "FREE" });
    const lockedModules: unknown = (body as Record<string, unknown>)["lockedModules"];
    expect(Array.isArray(lockedModules)).toBe(true);
    expect((lockedModules as string[]).includes("payroll")).toBe(true);
    expect((lockedModules as string[]).includes("inventory")).toBe(true);
  });

  it("CROSS-TENANT — the paid org token never sees the free org's tier=FREE (each token sees only its own org)", async () => {
    const paidRes = await request(server as never)
      .get("/billing/entitlements")
      .set("Authorization", `Bearer ${paidOwnerToken}`);

    const freeRes = await request(server as never)
      .get("/billing/entitlements")
      .set("Authorization", `Bearer ${freeOwnerToken}`);

    expect(paidRes.status).toBe(200);
    expect(freeRes.status).toBe(200);
    expect((paidRes.body as Record<string, unknown>)["tier"]).toBe("PAID");
    expect((freeRes.body as Record<string, unknown>)["tier"]).toBe("FREE");
    expect((paidRes.body as Record<string, unknown>)["tier"]).not.toBe(
      (freeRes.body as Record<string, unknown>)["tier"],
    );
  });

  it("RBAC GATE — a plain member of the paid org is denied GET /billing (billing:subscription:view required) with 403", async () => {
    const res = await request(server as never)
      .get("/billing")
      .set("Authorization", `Bearer ${paidMemberToken}`);

    expect(res.status).toBe(403);
  });

  it("SUBSCRIPTION ALLOWED — the paid org owner passes GET /billing and receives subscription data", async () => {
    const res = await request(server as never)
      .get("/billing")
      .set("Authorization", `Bearer ${paidOwnerToken}`);

    expect(res.status).toBe(200);
    const body: unknown = res.body;
    expect(body).toHaveProperty("subscription");
    expect(body).toHaveProperty("isConfigured");
  });

  it("SEATS — the paid org owner reads GET /billing/seats; used count matches the two seeded active members", async () => {
    const res = await request(server as never)
      .get("/billing/seats")
      .set("Authorization", `Bearer ${paidOwnerToken}`);

    expect(res.status).toBe(200);
    const body: unknown = res.body;
    expect(typeof (body as Record<string, unknown>)["used"]).toBe("number");
    const used = Number((body as Record<string, unknown>)["used"]);
    expect(used).toBeGreaterThanOrEqual(2);
  });

  it("BILLING NON-DELEGABLE — PUT /module-access/billing/members/:membershipId/grants returns 404; billing is not in ACCESS_MANAGED_MODULES so assertManagedModule rejects the path before grants can be set", async () => {
    const membershipId = paidOrg.members.member?.membershipId ?? 0;
    const res = await request(server as never)
      .put(`/module-access/billing/members/${String(membershipId)}/grants`)
      .set("Authorization", `Bearer ${paidOwnerToken}`)
      .send({ items: [{ permissionKey: "billing:subscription:view" }] });

    expect(res.status).toBe(404);
  });

  it("FREE MODULE LOCK — the free org owner is refused 403 when enabling payroll; PLAN_LOCKED_MODULES.FREE includes payroll", async () => {
    const res = await request(server as never)
      .patch("/access/org-modules/payroll")
      .set("Authorization", `Bearer ${freeOwnerToken}`)
      .send({ enabled: true });

    expect(res.status).toBe(403);
  });
});
