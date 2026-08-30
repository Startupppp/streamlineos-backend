import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { stubMembershipState } from "../../../test/helpers/membership-state";
import { installFixtureRegionRegistry } from "../../../test/helpers/e2e-app";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";

describe("/roles (e2e)", () => {
  let app: INestApplication;
  let ownerToken: string;
  let memberToken: string;
  let _rbacManagerToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const moduleRef = await stubMembershipState(
      Test.createTestingModule({ imports: [AppModule] }),
      {
        owner_rbac_1: { role: "OWNER", isOwner: true },
        member_rbac_1: { role: "MEMBER" },
        manager_rbac_1: { role: "MANAGER" },
      },
    ).compile();

    /**
     * Place the fixture organisation before anything reads its data.
     *
     * `org_rbac_01` is not a row in `organizations`, so `regionForOrg` correctly
     * refuses it and every request that reaches a handler dies with an unmapped
     * 500 — after the guards have already allowed it, which is why the 401 and
     * 403 cases here never noticed and the 200 ones all failed. `createE2eApp`
     * makes the same stub for the same reason; this suite builds its own module,
     * so it has to ask for it.
     */
    installFixtureRegionRegistry(moduleRef.get<Db>(DRIZZLE));

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    ownerToken = await signToken({ sub: "owner_rbac_1", orgId: "org_rbac_01" });
    memberToken = await signToken({ sub: "member_rbac_1", orgId: "org_rbac_01" });
    _rbacManagerToken = await signToken({ sub: "manager_rbac_1", orgId: "org_rbac_01" });
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
