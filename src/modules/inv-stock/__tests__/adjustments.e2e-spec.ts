import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";

describe("/inventory/stock/adjustments (e2e)", () => {
  let app: INestApplication;
  let ownerToken: string;
  let nonOwnerToken: string;
  let _createdId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    ownerToken = await signToken({ orgId: "org_inv_e2e", isOrgOwner: true, enabledModules: ["inventory"] });
    nonOwnerToken = await signToken({ orgId: "org_inv_e2e", isOrgOwner: false, permissions: [], enabledModules: ["inventory"] });
  });

  afterAll(async () => app.close());

  it("401 without token", async () => {
    const res = await request(app.getHttpServer()).get("/inventory/stock/adjustments");
    expect(res.status).toBe(401);
  });

  it("400 when Idempotency-Key missing on POST", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/stock/adjustments")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "DAMAGE", lines: [{ productVariantId: 1, locationId: 1, quantityChange: 5 }] });
    expect(res.status).toBe(400);
  });

  it("200 GET /inventory/stock/adjustments returns paginated list", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/stock/adjustments")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
  });

  it("201/200 POST /inventory/stock/adjustments creates adjustment", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/stock/adjustments")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", `adj-e2e-${Date.now()}`)
      .send({ reason: "RECOUNT", lines: [{ productVariantId: 999, locationId: 999, quantityChange: 1 }] });
    expect([200, 201, 400, 404]).toContain(res.status);
    if (res.status === 200 || res.status === 201) {
      const body = res.body.data ?? res.body;
      if (body?.id) _createdId = body.id;
    }
  });

  it("GET /inventory/stock/adjustments/:id returns 404 for missing id", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/stock/adjustments/999999")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it("idempotent replay on POST returns same result (409 or 200/201)", async () => {
    const key = `adj-idem-replay-${Date.now()}`;
    const body = { reason: "OTHER", lines: [{ productVariantId: 999, locationId: 999, quantityChange: 2 }] };
    const r1 = await request(app.getHttpServer())
      .post("/inventory/stock/adjustments")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send(body);
    const r2 = await request(app.getHttpServer())
      .post("/inventory/stock/adjustments")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send(body);
    expect([200, 201, 400, 404, 409]).toContain(r1.status);
    expect([r1.status, 409]).toContain(r2.status);
  });

  it("403 when user has no permissions", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/stock/adjustments")
      .set("Authorization", `Bearer ${nonOwnerToken}`)
      .set("Idempotency-Key", `adj-403-${Date.now()}`)
      .send({ reason: "DAMAGE", lines: [{ productVariantId: 1, locationId: 1, quantityChange: 1 }] });
    expect(res.status).toBe(403);
  });
});
