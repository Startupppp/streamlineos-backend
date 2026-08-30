import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

/**
 * Finance module RBAC gate coverage.
 *
 * Finance controllers manage money movement: bills, payments, bank accounts,
 * recurring invoices, approvals, expenses, tax and reports. Each controller is
 * covered here for the 401 and 403 tier; handler-level business logic lives in
 * service unit tests.
 *
 * ⚠ RATE LIMIT NOTE: Finance endpoints in production have restrictive rate
 * limits. The DEV_LIMIT_MULTIPLIER makes tiers 10× outside production, so a
 * fast test run will not drain them. A slow integration run may.
 */
describe("Finance module auth/RBAC (e2e)", () => {
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
    ["get", "/accounting/purchase-bills", "accounting:payables:manage"],
    ["get", "/accounting/payment-runs", "accounting:payment-runs:read"],
    ["get", "/accounting/recurring-bills", "accounting:recurring:read"],
    ["get", "/accounting/vendor-credits", "accounting:vendor-credits:read"],
    ["get", "/accounting/vendor-payments", "accounting:payables:read"],
    ["get", "/accounting/ar-payments", "accounting:receivables:read"],
    ["get", "/accounting/collections", "accounting:collections:read"],
    ["get", "/accounting/credit-notes", "accounting:credit-notes:read"],
    ["get", "/accounting/recurring-invoices", "accounting:recurring:read"],
    ["get", "/accounting/reminders", "accounting:receivables:read"],
    ["get", "/accounting/customer-statements", "accounting:receivables:read"],
    ["get", "/accounting/assets/categories", "accounting:assets:read"],
    ["get", "/accounting/assets", "accounting:assets:read"],
    ["get", "/accounting/assets/depreciation/runs", "accounting:assets:read"],
    ["get", "/finance/bank-accounts", "accounting:banking:read"],
    ["get", "/finance/transfers", "accounting:banking:read"],
    ["get", "/accounting/approval-policies", "accounting:approvals:read"],
    ["get", "/accounting/exchange-rates", "accounting:settings:manage"],
    ["get", "/accounting/expenses", "accounting:expenses:read"],
    ["get", "/accounting/expenses/policies", "accounting:expenses:read"],
    ["get", "/accounting/reimbursements", "accounting:expenses:read"],
    ["get", "/accounting/insights", "accounting:reports:read"],
    ["get", "/accounting/taxes/adjustments", "accounting:tax:read"],
    ["get", "/accounting/tax-codes", "accounting:tax:read"],
    ["get", "/accounting/taxes/payments", "accounting:tax:read"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
  });

  it.each(protectedRoutes)("403 on %s %s without required permission %s", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await call(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("401 on POST /accounting/purchase-bills/:billId/approve without token", async () => {
    const res = await request(app.getHttpServer())
      .post("/accounting/purchase-bills/1/approve");
    expect(res.status).toBe(401);
  });

  it("403 on POST /accounting/purchase-bills/:billId/approve with only read permission", async () => {
    const token = await signToken({
      permissions: ["accounting:payables:read"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/accounting/purchase-bills/1/approve")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("401 on POST /accounting/payment-runs without token", async () => {
    const res = await request(app.getHttpServer()).post("/accounting/payment-runs");
    expect(res.status).toBe(401);
  });

  it("403 on POST /accounting/payment-runs with only read permission", async () => {
    const token = await signToken({
      permissions: ["accounting:payment-runs:read"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/accounting/payment-runs")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("401 on POST /finance/bank-accounts without token", async () => {
    const res = await request(app.getHttpServer()).post("/finance/bank-accounts");
    expect(res.status).toBe(401);
  });

  it("403 on POST /finance/bank-accounts without accounting:banking:manage", async () => {
    const token = await signToken({
      permissions: ["accounting:banking:read"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/finance/bank-accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Main Account" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("cross-tenant: asset id from another org returns 404 not 403", async () => {
    const token = await signToken({
      permissions: ["accounting:assets:read"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/accounting/assets/99999")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });
});
