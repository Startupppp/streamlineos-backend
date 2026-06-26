import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("HR Payroll auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/hr/payrolls"],
    ["post", "/hr/payrolls"],
    ["get", "/hr/payrolls/all"],
    ["post", "/hr/payrolls/generate"],
    ["get", "/hr/payrolls/1/download"],
    ["get", "/hr/payroll-reports"],
    ["get", "/hr/payslips"],
    ["get", "/hr/dashboard/payroll-summary"],
    ["get", "/hr/dashboard/salary-bands"],
    ["get", "/hr/analytics/compensation"],
    ["post", "/hr/tax-calculator"],
    ["post", "/hr/integrations/accounting-export"],
    ["get", "/hr/bonuses"],
    ["post", "/hr/bonuses"],
    ["patch", "/hr/bonuses/1"],
    ["get", "/hr/loans"],
    ["post", "/hr/loans"],
    ["patch", "/hr/loans/1"],
    ["get", "/hr/incentives"],
    ["get", "/hr/incentives/config"],
    ["post", "/hr/incentives/config"],
    ["get", "/hr/incentives/stats"],
    ["patch", "/hr/incentives/1/approve"],
    ["patch", "/hr/incentives/1/reject"],
    ["get", "/hr/reimbursements"],
    ["post", "/hr/reimbursements"],
    ["get", "/hr/fnf"],
    ["post", "/hr/fnf"],
    ["patch", "/hr/fnf/1"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on POST /hr/bonuses without manage hr:bonuses", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/hr/bonuses")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "u1", type: "SPOT", amount: 100 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "hr:bonuses" });
  });

  it("403 on GET /hr/payroll-reports without read hr:payrolls", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/hr/payroll-reports")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "read", subject: "hr:payrolls" });
  });

  it("403 on POST /hr/integrations/accounting-export without manage hr:integrations", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/hr/integrations/accounting-export")
      .set("Authorization", `Bearer ${token}`)
      .send({ month: "2026-01" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "hr:integrations" });
  });

  it("404 MODULE_DISABLED on GET /hr/payrolls/all when hr module is off", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["crm"] });
    const res = await request(app.getHttpServer())
      .get("/hr/payrolls/all?month=2026-01")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "MODULE_DISABLED", module: "hr" });
  });

  it("403 on GET /hr/payrolls/all with hr enabled but no view hr:payroll", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["hr"] });
    const res = await request(app.getHttpServer())
      .get("/hr/payrolls/all?month=2026-01")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "hr:payroll" });
  });

  it("does NOT enforce an ability gate on POST /hr/tax-calculator (auth-only)", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/hr/tax-calculator")
      .set("Authorization", `Bearer ${token}`)
      .send({ annualCtc: 1200000 });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
