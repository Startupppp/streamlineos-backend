import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { hrPolicies } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * The first HR spec in this repository that runs against a database.
 *
 * The nine existing `*.e2e-spec.ts` suites under `src/modules/hr` are DB-less by
 * construction (`test/helpers/e2e-app.ts` says so in its header), and
 * `hr-cross-tenant-404.spec.ts` mocks the query builder — its `where` used to
 * accept anything, so deleting `eq(hrPolicies.orgId, orgId)` from the service
 * left all eighteen of its tests green. That spec now compiles the predicate and
 * asserts the tenant binding, which is as far as a mock can go: it can prove the
 * SQL was BUILT correctly, never that Postgres REFUSED the write.
 *
 * This file asks the remaining question. Two seeded organisations, the real
 * guards, the real RBAC resolver and a real Postgres:
 *
 *   allow        the owner's member reads and archives their own policy
 *   deny (RBAC)  a member without hr:policies:manage is refused the archive at 403,
 *                inside their own tenant, and the row does not change
 *   cross-tenant a member of org A asking for org B's policy id gets 404, not 403
 *                — a 403 would confirm the record exists (backend/CLAUDE.md §4)
 *   integrity    after the cross-tenant archive attempt, org B's row is re-read
 *                from the database and is still `draft`
 *
 * The last one is the assertion no mocked spec can make. A silent success and a
 * refusal are indistinguishable from the response alone when the response body
 * is `{ success: true }` either way; only the neighbour's row settles it.
 *
 * WHAT THIS FILE DOES *NOT* PROVE, measured rather than assumed. Deleting
 * `eq(hrPolicies.orgId, orgId)` from HrPoliciesService.archive leaves this file
 * GREEN, 6/6. The app connects as APP_DATABASE_URL (`streamline_app`,
 * rolbypassrls = false, not the table owner) and `hr_policies` carries
 * `tenant_isolation USING (org_id = current_org_id())`, so with the tenant GUC
 * set the neighbour's row is not visible to the UPDATE at all — 0 rows, hence
 * 404, with or without the service predicate. Confirmed directly:
 *
 *   psql as streamline_app; SET LOCAL app.organization_id = '<org A>';
 *   SELECT count(*) FROM hr_policies WHERE org_id <> '<org A>';   -- 0
 *
 * So this file proves the DEPLOYED SYSTEM refuses, which is the question the
 * nine DB-less HR suites could not ask. Attribution of that refusal to the
 * service's own predicate belongs to `src/modules/hr/hr-cross-tenant-404.spec.ts`,
 * which compiles the predicate and asserts the tenant binding. Neither file
 * replaces the other, and the RBAC leg below is the one this file can attribute
 * on its own: narrowing the archive route's key to `hr:policies:view` turns the
 * DENY case green-to-red here and nowhere else.
 */
describe("[seeded-e2e] HR policies — allow, deny and cross-tenant", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let homePolicyId = 0;
  let neighbourPolicyId = 0;
  let managerToken = "";
  let readerToken = "";
  let server: unknown;

  const policyValues = (orgId: string, name: string) => ({
    orgId,
    policyType: "leave" as const,
    name,
    status: "draft" as const,
    effectiveFrom: "2026-01-01",
    rules: { carryForwardDays: 5 },
  });

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("hr")
      .addMember("manager", {
        permissionKeys: ["hr:policies:view", "hr:policies:manage"],
      })
      .addMember("reader", { permissionKeys: ["hr:policies:view"] })
      .build();
    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("hr")
      .addMember("manager", {
        permissionKeys: ["hr:policies:view", "hr:policies:manage"],
      })
      .build();

    const [homePolicy] = await seeded.seedDb
      .insert(hrPolicies)
      .values(policyValues(home.orgId, "home leave policy"))
      .returning({ id: hrPolicies.id });
    const [neighbourPolicy] = await seeded.seedDb
      .insert(hrPolicies)
      .values(policyValues(neighbour.orgId, "neighbour leave policy"))
      .returning({ id: hrPolicies.id });
    homePolicyId = homePolicy?.id ?? 0;
    neighbourPolicyId = neighbourPolicy?.id ?? 0;

    managerToken = await signSeededToken(
      seeded,
      home.members.manager.userId,
      home.orgId,
    );
    readerToken = await signSeededToken(
      seeded,
      home.members.reader.userId,
      home.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (homePolicyId > 0)
      await seeded.seedDb.delete(hrPolicies).where(eq(hrPolicies.id, homePolicyId));
    if (neighbourPolicyId > 0)
      await seeded.seedDb.delete(hrPolicies).where(eq(hrPolicies.id, neighbourPolicyId));
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  async function statusOf(policyId: number): Promise<string | undefined> {
    const [row] = await seeded.seedDb
      .select({ status: hrPolicies.status })
      .from(hrPolicies)
      .where(eq(hrPolicies.id, policyId));
    return row?.status;
  }

  it("fixture check — the two policies are in different organisations", () => {
    expect(homePolicyId).toBeGreaterThan(0);
    expect(neighbourPolicyId).toBeGreaterThan(0);
    expect(homePolicyId).not.toBe(neighbourPolicyId);
    expect(home.orgId).not.toBe(neighbour.orgId);
  });

  it("ALLOW — the owner's manager reads their own policy", async () => {
    const response = await request(server as never)
      .get(`/hr/policies/${String(homePolicyId)}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(200);
  });

  it("CROSS-TENANT read — the neighbour's policy id answers 404, not 403", async () => {
    const response = await request(server as never)
      .get(`/hr/policies/${String(neighbourPolicyId)}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(404);
  });

  it("DENY — a member holding only :view is refused the archive at 403, and the row is untouched", async () => {
    const before = await statusOf(homePolicyId);
    const response = await request(server as never)
      .post(`/hr/policies/${String(homePolicyId)}/archive`)
      .set("Authorization", `Bearer ${readerToken}`)
      .set("Idempotency-Key", randomUUID());

    expect(response.status).toBe(403);
    expect(await statusOf(homePolicyId)).toBe(before);
  });

  it("CROSS-TENANT write — archiving the neighbour's policy answers 404 and leaves their row unchanged", async () => {
    expect(await statusOf(neighbourPolicyId)).toBe("draft");

    const response = await request(server as never)
      .post(`/hr/policies/${String(neighbourPolicyId)}/archive`)
      .set("Authorization", `Bearer ${managerToken}`)
      .set("Idempotency-Key", randomUUID());

    expect(response.status).toBe(404);
    expect(await statusOf(neighbourPolicyId)).toBe("draft");
  });

  it("ALLOW — the same manager archives their OWN policy, and only that row moves", async () => {
    const response = await request(server as never)
      .post(`/hr/policies/${String(homePolicyId)}/archive`)
      .set("Authorization", `Bearer ${managerToken}`)
      .set("Idempotency-Key", randomUUID());

    expect(response.status).toBe(200);
    expect(await statusOf(homePolicyId)).toBe("archived");
    expect(await statusOf(neighbourPolicyId)).toBe("draft");
  });
});
