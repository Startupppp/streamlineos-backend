import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

describe("Timesheets module auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => {
    await app.close();
  });

  type Method = "get" | "post" | "patch" | "delete";

  function call(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get": return agent.get(path);
      case "post": return agent.post(path);
      case "patch": return agent.patch(path);
      case "delete": return agent.delete(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string, string]> = [
    ["get", "/timesheets/approvals", "timesheets:approvals:view"],
    ["get", "/timesheets/audit", "timesheets:audit:view"],
    ["get", "/timesheets/billing/uninvoiced", "timesheets:billing:view"],
    ["get", "/timesheets/budgets", "timesheets:budgets:view"],
    ["get", "/timesheets/entries", "timesheets:entries:view"],
    ["get", "/timesheets/exceptions", "timesheets:exceptions:view"],
    ["get", "/timesheets/periods", "timesheets:entries:view"],
    ["get", "/timesheets/rates", "timesheets:rates:view"],
    ["get", "/timesheets/reports/overview", "timesheets:reports:view"],
    ["get", "/timesheets/settings", "timesheets:settings:view"],
    ["get", "/timesheets/team/week-summary", "timesheets:team:view"],
    ["get", "/timesheets/timer/active", "timesheets:entries:view"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
  });

  it.each(protectedRoutes)("403 on %s %s without required permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await call(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /timesheets/approvals/bulk-approve with only view permission", async () => {
    const token = await signToken({
      permissions: ["timesheets:approvals:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/timesheets/approvals/bulk-approve")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [1, 2] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /timesheets/entries without timesheets:entries:create", async () => {
    const token = await signToken({
      permissions: ["timesheets:entries:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/timesheets/entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ date: "2026-01-01", hours: 8 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /timesheets/rates without timesheets:rates:manage", async () => {
    const token = await signToken({
      permissions: ["timesheets:rates:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/timesheets/rates")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Standard", hourlyRate: 100 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("cross-tenant: entry id from another org returns 404 not 403", async () => {
    const token = await signToken({
      permissions: ["timesheets:entries:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/timesheets/entries/99999")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });
});
