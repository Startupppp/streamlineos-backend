import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("/roles (e2e)", () => {
  let app: INestApplication;
  let ownerToken: string;
  let memberToken: string;
  let rbacManagerToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    ownerToken = await signToken({ orgId: "org_rbac_01", role: "OWNER", isOrgOwner: true });
    memberToken = await signToken({ orgId: "org_rbac_01", role: "MEMBER", isOrgOwner: false, permissions: [] });
    rbacManagerToken = await signToken({ orgId: "org_rbac_01", role: "MANAGER", isOrgOwner: false, permissions: ["settings:rbac:manage"] });
  });

  afterAll(async () => app.close());

  describe("Authentication", () => {
    it("401 without token", async () => {
      const res = await request(app.getHttpServer()).get("/roles");
      expect(res.status).toBe(401);
    });

    it("200 on GET /roles with owner", async () => {
      const res = await request(app.getHttpServer())
        .get("/roles")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe("RBAC enforcement", () => {
    it("403 on POST /roles for plain member", async () => {
      const res = await request(app.getHttpServer())
        .post("/roles")
        .set("Authorization", `Bearer ${memberToken}`)
        .send({ name: "Test Role", slug: "test-role", permissions: [] });
      expect(res.status).toBe(403);
    });

    it("403 on DELETE /roles/:id for plain member", async () => {
      const res = await request(app.getHttpServer())
        .delete("/roles/999")
        .set("Authorization", `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /roles/analytics", () => {
    it("returns analytics shape with owner token", async () => {
      const res = await request(app.getHttpServer())
        .get("/roles/analytics")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const body = res.body.data ?? res.body;
      expect(body).toMatchObject({
        totalRoles: expect.any(Number),
        customRoles: expect.any(Number),
        systemRoles: expect.any(Number),
        totalPermissions: expect.any(Number),
        usersAssigned: expect.any(Number),
      });
    });
  });

  describe("GET /roles/templates", () => {
    it("returns templates array", async () => {
      const res = await request(app.getHttpServer())
        .get("/roles/templates")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data ?? res.body)).toBe(true);
    });
  });

  describe("GET /roles/simulate/:targetUserId", () => {
    it("400 or 403 for non-existent target user", async () => {
      const res = await request(app.getHttpServer())
        .get("/roles/simulate/nonexistent-user-id")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect([400, 403, 404]).toContain(res.status);
    });
  });
});
