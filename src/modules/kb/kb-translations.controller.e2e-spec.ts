import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { AccessService } from "../../modules/access/access.service";
import { KbIndexingService } from "../../modules/kb/kb-indexing.service";
import { KbTranslationsService } from "../../modules/kb/kb-translations.service";
describe("KB Translations auth/RBAC (e2e)", () => {
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
      .overrideProvider(KbTranslationsService)
      .useValue({
        list: async () => [],
        get: async () => ({ id: 1, articleId: 1, locale: "es", title: "Hola", content: "" }),
        upsert: async () => ({ id: 1, articleId: 1, locale: "es", title: "Hola", content: "" }),
        remove: async () => ({ deleted: true }),
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
    ["get", "/kb/articles/1/translations"],
    ["get", "/kb/articles/1/translations/es"],
    ["put", "/kb/articles/1/translations/es"],
    ["delete", "/kb/articles/1/translations/es"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  const abilities: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/articles/1/translations/es"],
    ["put", "/kb/articles/1/translations/es"],
    ["delete", "/kb/articles/1/translations/es"],
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
  });
});
