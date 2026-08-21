import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { KbIndexingService } from "../../modules/kb/kb-indexing.service";
import { KbCommentsService } from "../../modules/kb/kb-comments.service";

describe("KB Comments auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: KbIndexingService, useValue: {} },
        {
          provide: KbCommentsService,
          useValue: {
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
          },
        },
      ],
    });
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
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const abilities: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/articles/1/comments"],
    ["post", "/kb/articles/1/comments"],
    ["patch", "/kb/comments/1"],
    ["delete", "/kb/comments/1"],
    ["post", "/kb/comments/1/resolve"],
  ];

  it.each(abilities)("402 on %s %s when the kb module is not enabled", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "MODULE_NOT_ENABLED", details: { moduleKey: "kb" } });
  });

  it.each(abilities)("403 on %s %s without permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
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
      permissions: ["kb:articles:create"],
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
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1 });
    expect(res.body.resolvedAt).toBeDefined();
  });
});
