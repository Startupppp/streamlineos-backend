import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";

describe("/inventory/settings (e2e)", () => {
  let app: INestApplication;
  let ownerToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    ownerToken = await signToken({
      orgId: "org_inv_c2",
      isOrgOwner: true,
      enabledModules: ["inventory"],
    });
  });

  afterAll(async () => app.close());

  it("401 on GET /inventory/settings without token", async () => {
    const res = await request(app.getHttpServer()).get("/inventory/settings");
    expect(res.status).toBe(401);
  });

  it("200 on GET /inventory/settings with org owner token", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/settings")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
  });

  it("200 on PATCH /inventory/settings with valid body", async () => {
    const res = await request(app.getHttpServer())
      .patch("/inventory/settings")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ allowNegativeStock: false });
    expect(res.status).toBe(200);
  });

  it("400 on PATCH /inventory/settings with invalid payload type", async () => {
    const res = await request(app.getHttpServer())
      .patch("/inventory/settings")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ allowNegativeStock: "not-a-boolean" });
    expect(res.status).toBe(400);
  });

  describe("/inventory/quality/holds permission checks", () => {
    it("403 on POST /inventory/quality/holds when user lacks inventory:quality:inspect", async () => {
      const restrictedToken = await signToken({
        orgId: "org_inv_c2",
        isOrgOwner: false,
        permissions: [],
        enabledModules: ["inventory"],
      });

      const res = await request(app.getHttpServer())
        .post("/inventory/quality/holds")
        .set("Authorization", `Bearer ${restrictedToken}`)
        .set("Idempotency-Key", "test-hold-01")
        .send({ productVariantId: 1, locationId: 1, quantity: "1.0000", reason: "DAMAGED" });

      expect(res.status).toBe(403);
    });

    it("403 on POST /inventory/quality/holds/:holdId/release when user lacks inventory:quality:release", async () => {
      const restrictedToken = await signToken({
        orgId: "org_inv_c2",
        isOrgOwner: false,
        permissions: ["inventory:quality:inspect"],
        enabledModules: ["inventory"],
      });

      const res = await request(app.getHttpServer())
        .post("/inventory/quality/holds/999/release")
        .set("Authorization", `Bearer ${restrictedToken}`)
        .set("Idempotency-Key", "test-release-01")
        .send({});

      expect(res.status).toBe(403);
    });
  });

  describe("/inventory/channels/:channelId/sync-stock", () => {
    it("200 or 404 on POST /inventory/channels/:channelId/sync-stock with owner token", async () => {
      const res = await request(app.getHttpServer())
        .post("/inventory/channels/999999/sync-stock")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect([200, 404]).toContain(res.status);
    });

    it("401 on POST /inventory/channels/:channelId/sync-stock without token", async () => {
      const res = await request(app.getHttpServer()).post("/inventory/channels/1/sync-stock");
      expect(res.status).toBe(401);
    });
  });

  describe("/inventory/export/jobs", () => {
    it("201 on POST /inventory/export/jobs with valid exportType", async () => {
      const res = await request(app.getHttpServer())
        .post("/inventory/export/jobs")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ exportType: "products" });

      expect(res.status).toBe(201);
    });

    it("200 on GET /inventory/export/jobs", async () => {
      const res = await request(app.getHttpServer())
        .get("/inventory/export/jobs")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
    });

    it("401 on GET /inventory/export/jobs without token", async () => {
      const res = await request(app.getHttpServer()).get("/inventory/export/jobs");
      expect(res.status).toBe(401);
    });
  });
});
