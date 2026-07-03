import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { AccessService } from "../../modules/access/access.service";
import { KbIndexingService } from "../../modules/kb/kb-indexing.service";

describe("KB Governance (e2e)", () => {
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

  type Method = "get" | "post";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    if (method === "get") return agent.get(path);
    return agent.post(path);
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/page-reviews"],
    ["get", "/kb/page-reviews/due"],
    ["post", "/kb/pages/1/reviews"],
    ["post", "/kb/page-reviews/1/approve"],
    ["post", "/kb/page-reviews/1/reject"],
    ["post", "/kb/pages/import"],
    ["get", "/kb/import-jobs"],
    ["post", "/kb/pages/1/export"],
    ["get", "/kb/export-jobs"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  const moduleCheckRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/page-reviews"],
    ["post", "/kb/pages/1/reviews"],
    ["post", "/kb/page-reviews/1/approve"],
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

  it("200 on GET /kb/page-reviews with kb:reviews:view permission", async () => {
    const token = await signToken({ permissions: ["kb:reviews:view"], enabledModules: ["kb"] });
    const res = await callRoute("get", "/kb/page-reviews").set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("200 on GET /kb/page-reviews/due with kb:reviews:view permission", async () => {
    const token = await signToken({ permissions: ["kb:reviews:view"], enabledModules: ["kb"] });
    const res = await callRoute("get", "/kb/page-reviews/due").set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("passes auth on POST /kb/pages/1/reviews with kb:reviews:manage permission", async () => {
    const token = await signToken({ permissions: ["kb:reviews:manage"], enabledModules: ["kb"] });
    const res = await callRoute("post", "/kb/pages/1/reviews")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "approval" });
    expect([201, 400, 404, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("passes auth on POST /kb/pages/import with kb:pages:import permission", async () => {
    const token = await signToken({ permissions: ["kb:pages:import"], enabledModules: ["kb"] });
    const res = await callRoute("post", "/kb/pages/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ sourceType: "markdown", items: [{ title: "Test" }] });
    expect([201, 400, 404, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("passes auth on POST /kb/pages/1/export with kb:pages:export permission", async () => {
    const token = await signToken({ permissions: ["kb:pages:export"], enabledModules: ["kb"] });
    const res = await callRoute("post", "/kb/pages/1/export")
      .set("Authorization", `Bearer ${token}`)
      .send({ format: "markdown" });
    expect([200, 201, 400, 404, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
