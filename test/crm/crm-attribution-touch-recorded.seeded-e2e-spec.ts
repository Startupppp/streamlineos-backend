import request from "supertest";
import { and, eq } from "drizzle-orm";
import { crmLeadTouchpoints, orgModules } from "../../src/db/schema";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "../helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * The attribution reports are only as good as the log they read.
 *
 * `crm_lead_touchpoints` is the sole input to both campaign attribution reports,
 * and the only thing that writes it is `recordTouch`, fired as
 * `void this.attribution.recordTouch(...)` from `leads.service.ts`. That is the
 * shape backend/CLAUDE.md §4 warns about: work `void`-ed out of a handler runs
 * after the request transaction has committed, with the tenant GUC gone — and
 * `crm_lead_touchpoints` has RLS on with a `tenant_isolation` policy, so
 * `app.current_org_id()` would fail it closed with `42501`. The `.catch` logs a
 * warning nobody is reading, and both reports would quietly describe an empty
 * log while looking like they worked.
 *
 * They do not. The promise is created inside the handler, so the query is issued
 * while the context is still live and the row lands. This test is here to keep
 * that true: it is not a hypothesis, it is the thing that would break silently
 * if somebody deferred the call, awaited it later, or moved it past the commit.
 *
 * Which is why this goes through HTTP rather than calling the service. Only a
 * real request builds the tenant context this depends on; a direct call proves
 * nothing about the interceptor, and a mock proves nothing about RLS.
 */
describe("[seeded-e2e] creating a lead records its first touch", () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token: string;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("rep", { permissionKeys: ["crm:leads:create", "crm:leads:view"] })
      .build();

    // `PermissionGuard` answers 402 on a `crm:` key with no `org_modules` row.
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true });

    token = await signSeededToken(seeded, fixture.members.rep!.userId, fixture.orgId);
  }, 180_000);

  afterAll(async () => {
    await seeded.close();
  });

  it("writes the touchpoint the attribution reports read", async () => {
    const created = await request(seeded.app.getHttpServer())
      .post("/leads")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `attribution-touch-${Date.now()}`)
      .send({ name: "Touch Probe Ltd", source: "webinar" });

    expect(created.status).toBe(201);

    /*
      Fire-and-forget, so the row may not be there the instant the response is.
      Polled rather than slept once: a fixed wait is either flaky or slow, and
      this failing should mean "never written", not "not written yet".
    */
    const deadline = Date.now() + 10_000;
    let rows: { touchType: string; campaignId: number | null }[] = [];
    while (Date.now() < deadline) {
      rows = await seeded.seedDb
        .select({
          touchType: crmLeadTouchpoints.touchType,
          campaignId: crmLeadTouchpoints.campaignId,
        })
        .from(crmLeadTouchpoints)
        .where(
          and(
            eq(crmLeadTouchpoints.orgId, fixture.orgId),
            eq(crmLeadTouchpoints.touchType, "first_touch"),
          ),
        );
      if (rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // A zero here means the reports have been reading an empty log.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.touchType).toBe("first_touch");
  }, 180_000);
});
