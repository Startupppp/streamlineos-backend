import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import { KbCommentsService } from "./kb-comments.service";

describe("KB Comments auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: KbIndexingService, useValue: {} },
        {
          provide: KbCommentsService,
          useValue: {
            list: async () => [
              {
                id: 1,
                orgId: "org_1",
                articleId: 1,
                authorId: "user_1",
                content: "Great article",
                parentId: null,
                resolvedAt: null,
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                updatedAt: new Date("2026-01-01T00:00:00.000Z"),
                authorName: "Jamie Author",
              },
            ],
            create: async () => ({
              id: 1,
              orgId: "org_1",
              articleId: 1,
              authorId: "user_1",
              content: "Great article",
              parentId: null,
              resolvedAt: null,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }),
            update: async () => ({
              id: 1,
              orgId: "org_1",
              articleId: 1,
              authorId: "user_1",
              content: "Updated content",
              parentId: null,
              resolvedAt: null,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }),
            remove: async () => undefined,
            resolve: async () => ({
              id: 1,
              orgId: "org_1",
              articleId: 1,
              authorId: "user_1",
              content: "Great article",
              parentId: null,
              resolvedAt: new Date("2026-01-02T00:00:00.000Z"),
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-02T00:00:00.000Z"),
            }),
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

  /**
   * Never 402. `kb` is registered `planGated: false`, so `isCoreModuleKey("kb")` is true
   * and `moduleAvailability` answers `{ available: true }` before it reads a single
   * entitlement row — the constitution's rule that knowledge is platform core, not a
   * paid entitlement. This case asserted 402 and could never have passed. What it pins
   * now is the contract that does hold: an org with the module switched off still
   * reaches the permission check, and the permission check is what denies. The registry
   * half is pinned in src/modules/kb/kb-module-gate.spec.ts.
   */
  it.each(abilities)(
    "403 on %s %s with no permission even when the kb module is not enabled",
    async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: [] });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    },
  );

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
    expect(res.body).toMatchObject([{ id: 1, content: "Great article", authorName: "Jamie Author" }]);
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
