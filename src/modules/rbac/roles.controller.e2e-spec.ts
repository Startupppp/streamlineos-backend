import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken, ALL_MODULES } from "test/helpers/sign-token";

describe("/roles (e2e)", () => {
  let app: INestApplication;
  let ownerToken: string;
  let memberToken: string;

  beforeAll(async () => {
    app = await createE2eApp();
    ownerToken = await signToken({
      permissions: ["settings:rbac:manage"],
      enabledModules: ALL_MODULES,
      isOrgOwner: true,
    });
    memberToken = await signToken({
      permissions: [],
      enabledModules: ALL_MODULES,
    });
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
