import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";
import { cleanupSeedOrgs, seedOrg } from "../../../../test/helpers/e2e-seed";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { paymentProviders } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";

describe("Billing auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();

    /**
     * A provider row, so the webhook case can reach the signature check.
     *
     * `handlePaymentProviderWebhook` answers 503 before verifying anything when
     * the tenant has no provider registered — correctly, since there is no
     * secret to verify against. Without this the case asserting "rejects an
     * invalid signature" was asserting the absence of a fixture.
     *
     * `not_configured` is deliberate: any status but `disabled` resolves, the
     * adapter configures with no credentials, and an invalid signature is then
     * refused on its merits rather than for want of setup.
     */
    const db = app.get<Db>(DRIZZLE);
    await seedOrg(db, "org_1", "org-1-billing-e2e");
    await runInNewTenantTransaction(db, "org_1", (tx) =>
      tx
        .insert(paymentProviders)
        .values({
          orgId: "org_1",
          providerKey: "razorpay",
          displayName: "Razorpay",
          status: "not_configured",
        })
        .onConflictDoNothing(),
    );
  });

  afterAll(async () => {
    await cleanupSeedOrgs(app.get<Db>(DRIZZLE), ["org_1"]);
    await app.close();
  });

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
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/billing/razorpay")
      .set("Authorization", `Bearer ${token}`)
      .send({ plan: "STARTER" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /billing/razorpay without billing:subscription:manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
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
    // The route carries the tenant in the path now. A payment webhook arrives
    // from outside with no session, so which organisation it belongs to has to
    // be on the request — there is nothing else to read it from. Without the
    // segment this asserted 401 against a 404.
    const res = await request(app.getHttpServer())
      .post("/webhooks/razorpay/org_1")
      .set("x-razorpay-signature", "invalid")
      .send({ event: "payment.captured", payload: {} });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
  });
});
