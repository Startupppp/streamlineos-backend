import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import { KbTranslationsService } from "./kb-translations.service";

describe("KB Translations auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: KbIndexingService, useValue: {} },
        {
          provide: KbTranslationsService,
          useValue: {
            list: async () => [
              {
                id: 1,
                orgId: "org_1",
                articleId: 1,
                locale: "es",
                title: "Hola",
                content: "",
                contentText: "",
                excerpt: null,
                status: "draft",
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              },
            ],
            get: async () => ({
              id: 1,
              orgId: "org_1",
              articleId: 1,
              locale: "es",
              title: "Hola",
              content: "",
              contentText: "",
              excerpt: null,
              status: "draft",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }),
            upsert: async () => ({
              id: 1,
              orgId: "org_1",
              articleId: 1,
              locale: "es",
              title: "Hola",
              content: "",
              contentText: "",
              excerpt: null,
              status: "draft",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }),
            remove: async () => ({ success: true }),
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
    ["get", "/kb/articles/1/translations"],
    ["get", "/kb/articles/1/translations/es"],
    ["put", "/kb/articles/1/translations/es"],
    ["delete", "/kb/articles/1/translations/es"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const abilities: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/articles/1/translations/es"],
    ["put", "/kb/articles/1/translations/es"],
    ["delete", "/kb/articles/1/translations/es"],
  ];

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

  it("GET /kb/articles/1/translations/es returns translation for authorized user", async () => {
    const token = await signToken({
      permissions: ["kb:articles:view"],
      enabledModules: ["kb"],
    });
    const res = await request(app.getHttpServer())
      .get("/kb/articles/1/translations/es")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ locale: "es", title: "Hola" });
  });

  it("PUT /kb/articles/1/translations/es upserts translation with valid body", async () => {
    const token = await signToken({
      permissions: ["kb:articles:update"],
      enabledModules: ["kb"],
    });
    const res = await request(app.getHttpServer())
      .put("/kb/articles/1/translations/es")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Hola" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ locale: "es", title: "Hola" });
  });

  it("DELETE /kb/articles/1/translations/es deletes translation", async () => {
    const token = await signToken({
      permissions: ["kb:articles:update"],
      enabledModules: ["kb"],
    });
    const res = await request(app.getHttpServer())
      .delete("/kb/articles/1/translations/es")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });
});
