import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";

describe("PortalAccess auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
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

  const MEMBERSHIP_ID = "00000000-0000-0000-0000-000000000020";
  const GRANT_ID = "00000000-0000-0000-0000-000000000021";

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/portal-access/memberships"],
    ["post", "/portal-access/memberships"],
    ["patch", `/portal-access/memberships/${MEMBERSHIP_ID}/status`],
    ["get", "/portal-access/grants"],
    ["post", "/portal-access/grants"],
    ["patch", `/portal-access/grants/${GRANT_ID}`],
    ["post", `/portal-access/grants/${GRANT_ID}/revoke`],
  ];

  it.each(protectedRoutes)(
    "401 on %s %s without a token",
    async (method, path) => {
      const res = await callRoute(method, path);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    },
  );

  it("403 on POST /portal-access/memberships without projects:clientvisibility:manage permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/portal-access/memberships")
      .set("Authorization", `Bearer ${token}`)
      .send({ partyId: "00000000-0000-0000-0000-000000000099" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on POST /portal-access/grants without projects:clientvisibility:manage permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/portal-access/grants")
      .set("Authorization", `Bearer ${token}`)
      .send({ projectId: 1, portalMembershipId: MEMBERSHIP_ID });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on PATCH /portal-access/memberships/:id/status without projects:clientvisibility:manage permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .patch(`/portal-access/memberships/${MEMBERSHIP_ID}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "ACTIVE" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on POST /portal-access/grants/:id/revoke without projects:clientvisibility:manage permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post(`/portal-access/grants/${GRANT_ID}/revoke`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on GET /portal-access/memberships without projects:portal:view permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/portal-access/memberships")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on GET /portal-access/grants without projects:portal:view permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/portal-access/grants")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });
});
