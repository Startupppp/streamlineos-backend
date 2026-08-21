import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";

describe("Accounting auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
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
    ["get", "/accounting/accounts"],
    ["post", "/accounting/accounts"],
    ["patch", "/accounting/accounts/1"],
    ["get", "/accounting/journal"],
    ["post", "/accounting/journal"],
    ["get", "/accounting/journal/1"],
    ["post", "/accounting/journal/1/post"],
    ["post", "/accounting/journal/1/reverse"],
    ["get", "/accounting/reports/trial-balance"],
    ["get", "/accounting/reports/profit-loss"],
    ["get", "/accounting/reports/balance-sheet"],
    ["get", "/accounting/reports/cash-flow"],
    ["get", "/accounting/purchase-bills"],
    ["post", "/accounting/purchase-bills"],
    ["get", "/accounting/purchase-bills/1"],
    ["patch", "/accounting/purchase-bills/1"],
    ["get", "/accounting/purchase-bills/1/payments"],
    ["post", "/accounting/purchase-bills/1/payments"],
    ["get", "/accounting/vendors"],
    ["get", "/accounting/vendors/1/ledger"],
    ["get", "/accounting/customers"],
    ["get", "/accounting/customers/1/ledger"],
    ["get", "/accounting/reports/aged-receivables"],
    ["get", "/accounting/reports/aged-payables"],
    ["get", "/accounting/reports/gstr-1"],
    ["get", "/accounting/reports/gstr-3b"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /accounting/accounts without accounting:accounts read", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/accounting/accounts")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /accounting/journal without accounting:journal manage", async () => {
    const token = await signToken({ permissions: ["accounting:journal:read"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/accounting/journal")
      .set("Authorization", `Bearer ${token}`)
      .send({ entryDate: "2024-01-01", description: "x", lines: [] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /accounting/reports/trial-balance without accounting:reports read", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/accounting/reports/trial-balance?asOf=2024-01-01")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});
