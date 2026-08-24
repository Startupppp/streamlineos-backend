import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import { KbTagsService } from "./kb-tags.service";

describe("KB Tags auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: KbIndexingService, useValue: {} },
        {
          provide: KbTagsService,
          useValue: {
            list: async () => [],
            create: async () => ({ id: 1, name: "test", slug: "test", orgId: "org_1" }),
            remove: async () => ({ deleted: true }),
            getArticleTags: async () => [],
            setArticleTags: async () => [],
          },
        },
      ],
    });
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
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
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
    expect(res.body).toMatchObject({ code: "MODULE_NOT_ENABLED", details: { moduleKey: "kb" } });
  });

  it.each(abilities)("403 on %s %s without permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
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
