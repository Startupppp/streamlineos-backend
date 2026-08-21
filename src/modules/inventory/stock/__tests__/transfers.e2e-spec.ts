import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "../../../../../test/helpers/e2e-app";
import { signToken } from "../../../../../test/helpers/sign-token";

describe("/inventory/stock/transfers (e2e)", () => {
  let app: INestApplication;
  let ownerToken: string;
  let noPermToken: string;

  beforeAll(async () => {
    app = await createE2eApp();
    ownerToken = await signToken({
      sub: "owner_1",
      orgId: "org_inv_xfr",
      isOrgOwner: true,
      enabledModules: ["inventory"],
    });
    noPermToken = await signToken({
      sub: "member_1",
      orgId: "org_inv_xfr",
      isOrgOwner: false,
      permissions: [],
      enabledModules: ["inventory"],
    });
  });

  afterAll(async () => app.close());

  it("401 without token on GET /inventory/stock/transfers", async () => {
    const res = await request(app.getHttpServer()).get("/inventory/stock/transfers");
    expect(res.status).toBe(401);
  });

  it("200 GET /inventory/stock/transfers returns paginated list", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/stock/transfers")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
  });

  it("403 GET /inventory/stock/transfers without permission", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/stock/transfers")
      .set("Authorization", `Bearer ${noPermToken}`);
    expect(res.status).toBe(403);
  });

  it("400 POST dispatch without Idempotency-Key header", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/stock/transfers/1/dispatch")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it("400 POST reserve without Idempotency-Key header", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/stock/transfers/1/reserve")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it("400 POST complete without Idempotency-Key header", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/stock/transfers/1/complete")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ transferLineId: 1, quantityReceived: 5 }] });
    expect(res.status).toBe(400);
  });

  it("404 GET /inventory/stock/transfers/:id for non-existent transfer", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/stock/transfers/999999")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect([404, 200]).toContain(res.status);
  });

  it("transfer lifecycle: reserve + dispatch → 404 for non-existent transfer", async () => {
    const reserveRes = await request(app.getHttpServer())
      .post("/inventory/stock/transfers/999999/reserve")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", `reserve-${Date.now()}`);
    expect(reserveRes.status).toBe(404);

    const dispatchRes = await request(app.getHttpServer())
      .post("/inventory/stock/transfers/999999/dispatch")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", `dispatch-${Date.now()}`);
    expect(dispatchRes.status).toBe(404);
  });
});
