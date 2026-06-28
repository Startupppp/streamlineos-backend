import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { AccessService } from "../../modules/access/access.service";
import { KbIndexingService } from "../../modules/kb/kb-indexing.service";
describe("KB Articles auth/RBAC (e2e)", () => {
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
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/articles"],
    ["post", "/kb/articles"],
    ["get", "/kb/articles/1"],
    ["patch", "/kb/articles/1"],
    ["delete", "/kb/articles/1"],
    ["post", "/kb/articles/1/publish"],
    ["post", "/kb/articles/1/unpublish"],
    ["post", "/kb/articles/1/verify"],
    ["post", "/kb/articles/1/vote"],
    ["post", "/kb/articles/1/view"],
    ["get", "/kb/articles/1/versions"],
    ["post", "/kb/articles/1/versions/1/restore"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  const abilities: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/articles"],
    ["post", "/kb/articles"],
    ["patch", "/kb/articles/1"],
    ["delete", "/kb/articles/1"],
    ["post", "/kb/articles/1/publish"],
  ];

  it.each(abilities)("404 on %s %s when the kb module is disabled", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "MODULE_DISABLED", module: "kb" });
  });

  it.each(abilities)("403 on %s %s without permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });
});
