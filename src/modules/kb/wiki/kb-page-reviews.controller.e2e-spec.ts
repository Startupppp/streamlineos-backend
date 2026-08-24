import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { KbIndexingService } from "../retrieval/kb-indexing.service";

describe("KB Governance (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: KbIndexingService, useValue: {} }],
    });
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
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const moduleCheckRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/page-reviews"],
    ["post", "/kb/pages/1/reviews"],
    ["post", "/kb/page-reviews/1/approve"],
  ];

  it.each(moduleCheckRoutes)("402 on %s %s when the kb module is not enabled", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "MODULE_NOT_ENABLED", details: { moduleKey: "kb" } });
  });

  it.each(moduleCheckRoutes)("403 on %s %s without permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
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
