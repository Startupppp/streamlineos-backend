import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";

describe("Billing auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
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
    ["post", "/billing/razorpay"],
    ["patch", "/billing/razorpay"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on POST /billing/razorpay without billing:subscription:manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/billing/razorpay")
      .set("Authorization", `Bearer ${token}`)
      .send({ plan: "STARTER" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /billing/razorpay without billing:subscription:manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/billing/razorpay")
      .set("Authorization", `Bearer ${token}`)
      .send({
        razorpay_order_id: "order_1",
        razorpay_payment_id: "pay_1",
        razorpay_signature: "sig",
        plan: "STARTER",
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /billing without billing:subscription:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
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
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/billing/ai-credits/purchase")
      .set("Authorization", `Bearer ${token}`)
      .send({ packId: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("POST /webhooks/razorpay is public and rejects an invalid signature", async () => {
    const res = await request(app.getHttpServer())
      .post("/webhooks/razorpay")
      .set("x-razorpay-signature", "invalid")
      .send({ event: "payment.captured", payload: {} });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
  });
});
