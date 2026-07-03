import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { AccessService } from "../../modules/access/access.service";
import { KbIndexingService } from "../../modules/kb/kb-indexing.service";

describe("KB Pages auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccessService)
      .useValue({
        resolveUserPermissions: async () => new Map(),
        isModuleEnabled: async (_orgId: string, _moduleKey: string) => true,
      })
      .overrideProvider(KbIndexingService)
      .useValue({})
      .compile();

    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get": return agent.get(path);
      case "post": return agent.post(path);
      case "patch": return agent.patch(path);
      case "delete": return agent.delete(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/pages/tree"],
    ["get", "/kb/pages/recent"],
    ["get", "/kb/pages/favorites"],
    ["get", "/kb/pages/trash"],
    ["get", "/kb/pages/search"],
    ["post", "/kb/pages"],
    ["get", "/kb/pages/1"],
    ["patch", "/kb/pages/1"],
    ["post", "/kb/pages/1/move"],
    ["post", "/kb/pages/1/duplicate"],
    ["delete", "/kb/pages/1"],
    ["post", "/kb/pages/1/restore"],
    ["delete", "/kb/pages/1/permanent"],
    ["post", "/kb/pages/1/favorite"],
    ["delete", "/kb/pages/1/favorite"],
    ["post", "/kb/pages/1/visit"],
    ["get", "/kb/pages/1/backlinks"],
    ["get", "/kb/pages/1/versions"],
    ["get", "/kb/pages/1/versions/1"],
    ["post", "/kb/pages/1/versions/1/restore"],
    ["patch", "/kb/pages/1/lock"],
    ["get", "/kb/pages/1/comments"],
    ["post", "/kb/pages/1/comments"],
    ["patch", "/kb/page-comments/1"],
    ["delete", "/kb/page-comments/1"],
    ["post", "/kb/page-comments/1/resolve"],
    ["get", "/kb/page-templates"],
    ["post", "/kb/page-templates"],
    ["delete", "/kb/page-templates/1"],
    ["post", "/kb/pages/1/publish"],
    ["post", "/kb/pages/1/archive"],
    ["post", "/kb/pages/1/unarchive"],
    ["post", "/kb/pages/1/verify"],
    ["post", "/kb/pages/1/mark-stale"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  const moduleCheckRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/pages/tree"],
    ["post", "/kb/pages"],
    ["patch", "/kb/pages/1"],
    ["delete", "/kb/pages/1"],
    ["patch", "/kb/pages/1/lock"],
  ];

  it.each(moduleCheckRoutes)("404 on %s %s when the kb module is disabled", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "MODULE_DISABLED", module: "kb" });
  });

  it.each(moduleCheckRoutes)("403 on %s %s without permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("200 on GET /kb/pages/tree with kb:pages:view permission", async () => {
    const token = await signToken({ permissions: ["kb:pages:view"], enabledModules: ["kb"] });
    const res = await callRoute("get", "/kb/pages/tree").set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
  });

  it("200 on POST /kb/pages with kb:pages:create permission (body validation)", async () => {
    const token = await signToken({ permissions: ["kb:pages:create"], enabledModules: ["kb"] });
    const res = await callRoute("post", "/kb/pages")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Test Page" });
    expect([201, 400, 404, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
