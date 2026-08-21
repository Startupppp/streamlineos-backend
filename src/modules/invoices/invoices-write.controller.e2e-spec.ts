import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

describe("Invoices write auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "post" | "patch";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    return method === "post" ? agent.post(path) : agent.patch(path);
  }

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["patch", "/invoices/1"],
    ["post", "/invoices/1/payments"],
    ["post", "/invoices/recurring/run"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("does NOT require an ability on PATCH /invoices/:id (auth-only)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .patch("/invoices/999999")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "CANCELLED" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
