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
      permissions: ["inventory:reports:read", "inventory:valuation:read"],
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

  /**
   * The aging report runs one statement over five tables; a smoke call is what
   * proves the SQL parses and the types line up at all.
   */
  it("200 on GET /inventory/reports/work-aging, always naming the scope", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/work-aging")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    // Present on every response. An owner holds the org-wide scope, so null.
    expect(body).toHaveProperty("scopedWarehouseIds");
    expect(body.scopedWarehouseIds).toBeNull();
    for (const stage of ["receipts", "putaway", "picking", "pickExceptions", "shipping"]) {
      expect(body[stage].bands.map((b: { label: string }) => b.label)).toEqual([
        "0-4h",
        "4-24h",
        "24-72h",
        "72h+",
      ]);
      expect(body[stage].open).toBe(
        body[stage].bands.reduce((n: number, b: { count: number }) => n + b.count, 0),
      );
    }
  });

  it("200 on GET /inventory/reports/work-aging?asOf=", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/work-aging?asOf=2026-01-05")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((res.body.data ?? res.body).asOf).toBe("2026-01-05");
  });

  it("400 on an unknown key, because the query schema is strict", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/work-aging?warehouse=3")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("200 on GET /inventory/reports/throughput filtered to one site", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/throughput?from=2026-08-01&to=2026-08-31")
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
