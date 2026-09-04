import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { finPaymentRuns } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Payment runs (accounting) — cross-tenant isolation and RBAC (seeded database).
 *
 * Routes exercised
 *   GET  /accounting/payment-runs/:runId         — requires accounting:payment-runs:read
 *   POST /accounting/payment-runs/:runId/approve — requires accounting:payment-runs:approve
 *                                                  carries @Idempotent; needs Idempotency-Key
 *
 * Module key: "accounting"  Plan: PAID (STARTER internally)
 *
 * WHAT THIS FILE PROVES
 * — An org A manager gets 404, never 403, when reading org B's payment run id. A
 *   403 would confirm the record exists and turn the read endpoint into an existence
 *   oracle — the 404 assertion is the one that breaks if the tenant predicate is
 *   removed from the service's SELECT.
 * — A member holding only accounting:payment-runs:read is refused POST approve at
 *   403 (RBAC leg). The run status in the database does not change — a silent write
 *   and a guard refusal are otherwise indistinguishable from the response body alone.
 * — An org A manager gets 404 when calling approve on org B's run id, and org B's
 *   run status is still "DRAFT" after the attempt (DB re-read). This is the assertion
 *   no DB-less spec can make: only the neighbour's row read from the database settles it.
 *
 * WHAT THIS FILE DOES NOT PROVE
 * — Attribution of the cross-tenant refusal to the service predicate vs. an RLS
 *   policy on fin_payment_runs scoped to app.current_org_id(). If the table carries
 *   a tenant RLS policy the refusal may hold with the service predicate deleted. That
 *   attribution belongs to a unit spec that compiles and asserts the WHERE clause.
 *   This file proves the DEPLOYED SYSTEM refuses.
 * — Concurrent-access safety or duplicate-approve idempotency beyond the single-key
 *   proof the @Idempotent interceptor provides.
 */
describe("[seeded-e2e] Payment runs — cross-tenant isolation and RBAC enforcement", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let homeRunId = 0;
  let neighbourRunId = 0;
  let managerToken = "";
  let readerToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("accounting")
      .addMember("manager", {
        permissionKeys: [
          "accounting:payment-runs:read",
          "accounting:payment-runs:manage",
          "accounting:payment-runs:approve",
        ],
      })
      .addMember("reader", { permissionKeys: ["accounting:payment-runs:read"] })
      .build();

    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("accounting")
      .addMember("manager", {
        permissionKeys: [
          "accounting:payment-runs:read",
          "accounting:payment-runs:manage",
          "accounting:payment-runs:approve",
        ],
      })
      .build();

    const [homeRun] = await seeded.seedDb
      .insert(finPaymentRuns)
      .values({
        orgId: home.orgId,
        name: "home-payment-run",
        createdBy: home.members.manager.userId,
      })
      .returning({ id: finPaymentRuns.id });
    const [neighbourRun] = await seeded.seedDb
      .insert(finPaymentRuns)
      .values({
        orgId: neighbour.orgId,
        name: "neighbour-payment-run",
        createdBy: neighbour.members.manager.userId,
      })
      .returning({ id: finPaymentRuns.id });
    homeRunId = homeRun?.id ?? 0;
    neighbourRunId = neighbourRun?.id ?? 0;

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
    if (homeRunId > 0)
      await seeded.seedDb.delete(finPaymentRuns).where(eq(finPaymentRuns.id, homeRunId));
    if (neighbourRunId > 0)
      await seeded.seedDb.delete(finPaymentRuns).where(eq(finPaymentRuns.id, neighbourRunId));
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  async function paymentRunStatusOf(runId: number): Promise<string | undefined> {
    const [row] = await seeded.seedDb
      .select({ status: finPaymentRuns.status })
      .from(finPaymentRuns)
      .where(eq(finPaymentRuns.id, runId));
    return row?.status;
  }

  it("fixture check — two payment runs exist in separate organisations", () => {
    expect(homeRunId).toBeGreaterThan(0);
    expect(neighbourRunId).toBeGreaterThan(0);
    expect(homeRunId).not.toBe(neighbourRunId);
    expect(home.orgId).not.toBe(neighbour.orgId);
  });

  it("ALLOW — a manager with accounting:payment-runs:read reads their own payment run", async () => {
    const response = await request(server as never)
      .get(`/accounting/payment-runs/${String(homeRunId)}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(200);
  });

  it("CROSS-TENANT read — org A manager gets 404, not 403, for org B payment run id", async () => {
    const response = await request(server as never)
      .get(`/accounting/payment-runs/${String(neighbourRunId)}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(404);
  });

  it("DENY — a reader without accounting:payment-runs:approve is refused approve at 403 and the run status is unchanged", async () => {
    const before = await paymentRunStatusOf(homeRunId);

    const response = await request(server as never)
      .post(`/accounting/payment-runs/${String(homeRunId)}/approve`)
      .set("Authorization", `Bearer ${readerToken}`)
      .set("Idempotency-Key", randomUUID());

    expect(response.status).toBe(403);
    expect(await paymentRunStatusOf(homeRunId)).toBe(before);
  });

  it("CROSS-TENANT write — approving org B payment run answers 404 and org B status is unchanged", async () => {
    expect(await paymentRunStatusOf(neighbourRunId)).toBe("DRAFT");

    const response = await request(server as never)
      .post(`/accounting/payment-runs/${String(neighbourRunId)}/approve`)
      .set("Authorization", `Bearer ${managerToken}`)
      .set("Idempotency-Key", randomUUID());

    expect(response.status).toBe(404);
    expect(await paymentRunStatusOf(neighbourRunId)).toBe("DRAFT");
  });
});
