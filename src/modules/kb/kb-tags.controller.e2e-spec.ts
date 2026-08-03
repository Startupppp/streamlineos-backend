import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { AccessService } from "../../modules/access/access.service";
import { KbIndexingService } from "../../modules/kb/kb-indexing.service";
import { KbTagsService } from "../../modules/kb/kb-tags.service";
describe("KB Tags auth/RBAC (e2e)", () => {
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
      .overrideProvider(KbTagsService)
      .useValue({
        list: async () => [],
        create: async () => ({ id: 1, name: "test", slug: "test", orgId: "org_1" }),
        remove: async () => ({ deleted: true }),
        getArticleTags: async () => [],
        setArticleTags: async () => [],
      })
      .compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete" | "put";

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
      case "put":
        return agent.put(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/tags"],
    ["post", "/kb/tags"],
    ["delete", "/kb/tags/1"],
    ["get", "/kb/articles/1/tags"],
    ["put", "/kb/articles/1/tags"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  const abilities: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/tags"],
    ["post", "/kb/tags"],
    ["delete", "/kb/tags/1"],
    ["get", "/kb/articles/1/tags"],
    ["put", "/kb/articles/1/tags"],
  ];

  it.each(abilities)("402 on %s %s when the kb module is not enabled", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "MODULE_NOT_ENABLED", moduleKey: "kb" });
  });

  it.each(abilities)("403 on %s %s without permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("GET /kb/tags returns tag list for authorized user", async () => {
    const token = await signToken({
      permissions: ["kb:spaces:view"],
      enabledModules: ["kb"],
    });
    const res = await request(app.getHttpServer())
      .get("/kb/tags")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /kb/tags creates a tag with valid body", async () => {
    const token = await signToken({
      permissions: ["kb:articles:manage"],
      enabledModules: ["kb"],
    });
    const res = await request(app.getHttpServer())
      .post("/kb/tags")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "test" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, name: "test", slug: "test" });
  });

  it("GET /kb/articles/1/tags returns article tags for authorized user", async () => {
    const token = await signToken({
      permissions: ["kb:articles:view"],
      enabledModules: ["kb"],
    });
    const res = await request(app.getHttpServer())
      .get("/kb/articles/1/tags")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
