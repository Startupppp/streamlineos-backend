import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { payrollApprovals, payrollRuns } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

describe("[seeded-e2e] Payroll runs — authorization, domain-verb gating, self-service and cross-tenant isolation", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let freeOrg: SeededFixture;
  let homeRunId = 0;
  let neighbourRunId = 0;
  let homeApprovalId = 0;
  let managerToken = "";
  let viewerToken = "";
  let controllerToken = "";
  let plainToken = "";
  let freeOwnerToken = "";
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
      .addMember("controller", {
        permissionKeys: ["payroll:runs:view", "payroll:runs:manage"],
      })
      .addMember("plain", { permissionKeys: [] })
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

    freeOrg = await seedOrg(seeded.seedDb)
      .addMember("owner", { standing: "OWNER" })
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

    const [homeApproval] = await seeded.seedDb
      .insert(payrollApprovals)
      .values({
        orgId: home.orgId,
        runId: homeRunId,
        stage: 1,
        stageName: "final-approval",
        requiredPermission: "payroll:runs:approve",
      })
      .returning({ id: payrollApprovals.id });
    homeApprovalId = homeApproval?.id ?? 0;

    managerToken = await signSeededToken(
      seeded,
      home.members.manager?.userId ?? "",
      home.orgId,
    );
    viewerToken = await signSeededToken(
      seeded,
      home.members.viewer?.userId ?? "",
      home.orgId,
    );
    controllerToken = await signSeededToken(
      seeded,
      home.members.controller?.userId ?? "",
      home.orgId,
    );
    plainToken = await signSeededToken(
      seeded,
      home.members.plain?.userId ?? "",
      home.orgId,
    );
    freeOwnerToken = await signSeededToken(
      seeded,
      freeOrg.members.owner?.userId ?? "",
      freeOrg.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (homeApprovalId > 0)
      await seeded.seedDb
        .delete(payrollApprovals)
        .where(eq(payrollApprovals.id, homeApprovalId));
    if (homeRunId > 0)
      await seeded.seedDb
        .delete(payrollRuns)
        .where(eq(payrollRuns.id, homeRunId));
    if (neighbourRunId > 0)
      await seeded.seedDb
        .delete(payrollRuns)
        .where(eq(payrollRuns.id, neighbourRunId));
    if (freeOrg) await freeOrg.teardown();
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

  it("fixture check — two runs and one approval exist in separate organisations", () => {
    expect(homeRunId).toBeGreaterThan(0);
    expect(neighbourRunId).toBeGreaterThan(0);
    expect(homeApprovalId).toBeGreaterThan(0);
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

  it("DOMAIN VERB — payroll:runs:manage alone does not satisfy payroll:runs:approve; the approval stage is refused at 403", async () => {
    const response = await request(server as never)
      .post(
        `/payroll/runs/${String(homeRunId)}/approvals/${String(homeApprovalId)}/approve`,
      )
      .set("Authorization", `Bearer ${controllerToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({});

    expect(response.status).toBe(403);
  });

  it("SELF-SERVICE — a plain member with no explicit grants reaches GET /payroll/me/overview at 200 via EMPLOYEE_SELF_SERVICE_GRANTS", async () => {
    const response = await request(server as never)
      .get("/payroll/me/overview")
      .set("Authorization", `Bearer ${plainToken}`);

    expect(response.status).toBe(200);
  });

  it("FREE-PLAN GATE — enabling the payroll module on a FREE-plan org is refused at 403 by entitlements.service", async () => {
    const response = await request(server as never)
      .patch("/access/org-modules/payroll")
      .set("Authorization", `Bearer ${freeOwnerToken}`)
      .send({ enabled: true });

    expect(response.status).toBe(403);
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
