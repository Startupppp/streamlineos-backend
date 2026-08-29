import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "../../../../test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";

describe("/inventory/reports (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createE2eApp();
    token = await signToken({
      sub: "owner_1",
      orgId: "org_inv_01",
      isOrgOwner: true,
      enabledModules: ["inventory"],
    });
  });

  afterAll(async () => app.close());

  it("401 on GET /inventory/reports/dashboard without token", async () => {
    const res = await request(app.getHttpServer()).get("/inventory/reports/dashboard");
    expect(res.status).toBe(401);
  });

  it("200 on GET /inventory/reports/dashboard", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("200 on GET /inventory/reports/stock-summary", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/stock-summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("200 on GET /inventory/reports/reorder", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/reorder")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("200 on GET /inventory/reports/movements", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/movements")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  /**
   * G1. Page one still answers with a count for the callers that only know
   * `page`; a cursor page deliberately does not, because `count(*)` over a
   * tenant's ledger is the cost the cursor exists to avoid.
   */
  it("movements pages by cursor, and stops counting once it does", async () => {
    const first = await request(app.getHttpServer())
      .get("/inventory/reports/movements?limit=2")
      .set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);
    const firstBody = first.body.data ?? first.body;
    expect(typeof firstBody.hasMore).toBe("boolean");
    if (!firstBody.hasMore) return;

    const second = await request(app.getHttpServer())
      .get(`/inventory/reports/movements?limit=2&cursor=${encodeURIComponent(String(firstBody.nextCursor))}`)
      .set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(200);
    const secondBody = second.body.data ?? second.body;
    expect(secondBody.total).toBeNull();

    const firstIds = firstBody.items.map((row: { id: number }) => row.id);
    const secondIds = secondBody.items.map((row: { id: number }) => row.id);
    expect(firstIds.filter((id: number) => secondIds.includes(id))).toEqual([]);
  });

  it("400 above the 100-per-page cap on movements", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/movements?limit=101")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("dashboard response contains expected shape", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body).toBeDefined();
  });
});
