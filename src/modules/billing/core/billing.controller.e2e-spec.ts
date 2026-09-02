import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";
import { BillingService } from "./billing.service";

const stubBilling = {
  handlePaymentProviderWebhook: jest.fn().mockResolvedValue({ status: 401, body: { ok: false } }),
  createOrder: jest.fn().mockResolvedValue({ orderId: "order_1", amount: 100, currency: "INR", keyId: "key_1" }),
  verifyAndActivate: jest.fn().mockResolvedValue({ success: true, plan: "STARTER", status: "ACTIVE" }),
};

describe("Billing auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: BillingService, useValue: stubBilling }],
    });
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/billing"],
    ["post", "/billing/checkout"],
    ["patch", "/billing/checkout"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on POST /billing/checkout without billing:subscription:manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/billing/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ plan: "STARTER" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /billing/checkout without billing:subscription:manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .patch("/billing/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({
        orderId: "order_1",
        paymentId: "pay_1",
        signature: "sig",
        plan: "STARTER",
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /billing without billing:subscription:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/billing")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("401 on POST /billing/ai-credits/purchase without a token", async () => {
    const res = await request(app.getHttpServer())
      .post("/billing/ai-credits/purchase")
      .send({ packId: 1 });
    expect(res.status).toBe(401);
  });

  it("403 on POST /billing/ai-credits/purchase without billing:ai-credits:purchase permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/billing/ai-credits/purchase")
      .set("Authorization", `Bearer ${token}`)
      .send({ packId: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("POST /webhooks/razorpay/:orgId is public and rejects an invalid signature", async () => {
    const res = await request(app.getHttpServer())
      .post("/webhooks/razorpay/org_1")
      .set("x-razorpay-signature", "invalid")
      .send({ event: "payment.captured", payload: {} });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
  });
});
