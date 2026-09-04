import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { payrollRuns } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Payroll runs — authorization and cross-tenant isolation (seeded database).
 *
 * Routes exercised
 *   GET  /payroll/runs/:runId              — requires payroll:runs:view
 *   POST /payroll/runs/:runId/submit-approval — requires payroll:runs:update
 *
 * Module key: "payroll"  Plan: PAID (STARTER internally)
 *
 * WHAT THIS FILE PROVES
 * — A member holding only payroll:runs:view is refused POST submit-approval at 403
 *   (RBAC leg). The PermissionGuard fires before the service so the run status in
 *   the database does not move — a { success: true }-shaped response and a 403 are
 *   otherwise indistinguishable from the body alone.
 * — An org A manager gets 404, never 403, when reading org B's run id. A 403 would
 *   confirm the record exists and turn the endpoint into an existence oracle.
 * — An org A manager gets 404 when calling submit-approval on org B's run id, and
 *   org B's run status is unchanged afterwards (DB re-read). This is the assertion
 *   no DB-less spec can make.
 *
 * WHAT THIS FILE DOES NOT PROVE
 * — Attribution of the cross-tenant refusal to the service's own WHERE predicate
 *   vs. an RLS policy on payroll_runs scoped to app.current_org_id(). Deleting the
 *   service predicate may leave the cross-tenant cases green if the RLS policy is
 *   intact. That attribution belongs to a unit spec that compiles and asserts the
 *   Drizzle WHERE clause. This file proves the DEPLOYED SYSTEM refuses, which the
 *   existing DB-less suites cannot ask.
 * — Plan-gate enforcement (a FREE-plan org being denied payroll module access).
 */
describe("[seeded-e2e] Payroll runs — authorization and cross-tenant isolation", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let homeRunId = 0;
  let neighbourRunId = 0;
  let managerToken = "";
  let viewerToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("payroll")
      .addMember("manager", {
        permissionKeys: [
          "payroll:runs:view",
          "payroll:runs:update",
          "payroll:runs:approve",
          "payroll:runs:manage",
        ],
      })
      .addMember("viewer", { permissionKeys: ["payroll:runs:view"] })
      .build();

    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("payroll")
      .addMember("manager", {
        permissionKeys: [
          "payroll:runs:view",
          "payroll:runs:update",
          "payroll:runs:approve",
          "payroll:runs:manage",
        ],
      })
      .build();

    const [homeRun] = await seeded.seedDb
      .insert(payrollRuns)
      .values({ orgId: home.orgId, month: "2026-01" })
      .returning({ id: payrollRuns.id });
    const [neighbourRun] = await seeded.seedDb
      .insert(payrollRuns)
      .values({ orgId: neighbour.orgId, month: "2026-01" })
      .returning({ id: payrollRuns.id });
    homeRunId = homeRun?.id ?? 0;
    neighbourRunId = neighbourRun?.id ?? 0;

    managerToken = await signSeededToken(
      seeded,
      home.members.manager.userId,
      home.orgId,
    );
    viewerToken = await signSeededToken(
      seeded,
      home.members.viewer.userId,
      home.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (homeRunId > 0)
      await seeded.seedDb.delete(payrollRuns).where(eq(payrollRuns.id, homeRunId));
    if (neighbourRunId > 0)
      await seeded.seedDb.delete(payrollRuns).where(eq(payrollRuns.id, neighbourRunId));
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  async function runStatusOf(runId: number): Promise<string | undefined> {
    const [row] = await seeded.seedDb
      .select({ status: payrollRuns.status })
      .from(payrollRuns)
      .where(eq(payrollRuns.id, runId));
    return row?.status;
  }

  it("fixture check — two runs exist in separate organisations", () => {
    expect(homeRunId).toBeGreaterThan(0);
    expect(neighbourRunId).toBeGreaterThan(0);
    expect(homeRunId).not.toBe(neighbourRunId);
    expect(home.orgId).not.toBe(neighbour.orgId);
  });

  it("ALLOW — a manager with payroll:runs:view reads their own run", async () => {
    const response = await request(server as never)
      .get(`/payroll/runs/${String(homeRunId)}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(200);
  });

  it("DENY — a viewer without payroll:runs:update is refused submit-approval at 403 and the run status is unchanged", async () => {
    const before = await runStatusOf(homeRunId);

    const response = await request(server as never)
      .post(`/payroll/runs/${String(homeRunId)}/submit-approval`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .set("Idempotency-Key", randomUUID());

    expect(response.status).toBe(403);
    expect(await runStatusOf(homeRunId)).toBe(before);
  });

  it("CROSS-TENANT read — org A manager gets 404, not 403, for org B run id", async () => {
    const response = await request(server as never)
      .get(`/payroll/runs/${String(neighbourRunId)}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(404);
  });

  it("CROSS-TENANT write — submit-approval on org B run answers 404 and org B status is unchanged", async () => {
    expect(await runStatusOf(neighbourRunId)).toBe("PREPARING");

    const response = await request(server as never)
      .post(`/payroll/runs/${String(neighbourRunId)}/submit-approval`)
      .set("Authorization", `Bearer ${managerToken}`)
      .set("Idempotency-Key", randomUUID());

    expect(response.status).toBe(404);
    expect(await runStatusOf(neighbourRunId)).toBe("PREPARING");
  });
});
