import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { AccessService } from "../../modules/access/access.service";
import { KbIndexingService } from "../../modules/kb/kb-indexing.service";
import { KbCommentsService } from "../../modules/kb/kb-comments.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

describe("KB Comments auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccessService)
      .useValue({
        resolveUserPermissions: async () => new Map(),
        getModuleEnabled: (ctx: CurrentUserContext, moduleKey: string) =>
          ctx.enabledModules?.includes(moduleKey) ?? true,
      })
      .overrideProvider(KbIndexingService)
      .useValue({})
      .overrideProvider(KbCommentsService)
      .useValue({
        list: async () => [],
        create: async () => ({
          id: 1,
          articleId: 1,
          authorId: "user_1",
          content: "Great article",
          parentId: null,
          resolvedAt: null,
        }),
        update: async () => ({ id: 1, content: "Updated content" }),
        remove: async () => undefined,
        resolve: async () => ({ id: 1, resolvedAt: new Date().toISOString() }),
      })
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
    ["get", "/kb/articles/1/comments"],
    ["post", "/kb/articles/1/comments"],
    ["patch", "/kb/comments/1"],
    ["delete", "/kb/comments/1"],
    ["post", "/kb/comments/1/resolve"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  const abilities: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/articles/1/comments"],
    ["post", "/kb/articles/1/comments"],
    ["patch", "/kb/comments/1"],
    ["delete", "/kb/comments/1"],
    ["post", "/kb/comments/1/resolve"],
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

  it("GET /kb/articles/1/comments returns comment list for authorized user", async () => {
    const token = await signToken({
      permissions: ["kb:articles:view"],
      enabledModules: ["kb"],
    });
    const res = await request(app.getHttpServer())
      .get("/kb/articles/1/comments")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /kb/articles/1/comments creates comment with valid body", async () => {
    const token = await signToken({
      permissions: ["kb:articles:view"],
      enabledModules: ["kb"],
    });
    const res = await request(app.getHttpServer())
      .post("/kb/articles/1/comments")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "Great article" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, content: "Great article" });
  });

  it("POST /kb/comments/1/resolve resolves a comment", async () => {
    const token = await signToken({
      permissions: ["kb:articles:update"],
      enabledModules: ["kb"],
    });
    const res = await request(app.getHttpServer())
      .post("/kb/comments/1/resolve")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1 });
    expect(res.body.resolvedAt).toBeDefined();
  });
});
