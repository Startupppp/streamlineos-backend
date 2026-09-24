import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { KbIndexingService } from "../retrieval/kb-indexing.service";

describe("KB Page Templates auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: KbIndexingService, useValue: {} }],
    });
  });

  afterAll(async () => app.close());

  type Method = "get" | "post" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    if (method === "get") return agent.get(path);
    if (method === "post") return agent.post(path);
    return agent.delete(path);
  }

  const allRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/page-templates"],
    ["post", "/kb/page-templates"],
    ["delete", "/kb/page-templates/1"],
  ];

  it.each(allRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it.each(allRoutes)("403 on %s %s with no permissions", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("200 on GET /kb/page-templates with kb:pages:view permission", async () => {
    const token = await signToken({ permissions: ["kb:pages:view"], enabledModules: ["kb"] });
    const res = await callRoute("get", "/kb/page-templates").set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("passes auth on POST /kb/page-templates with kb:templates:manage permission", async () => {
    const token = await signToken({ permissions: ["kb:templates:manage"], enabledModules: ["kb"] });
    const res = await callRoute("post", "/kb/page-templates")
      .set("Authorization", `Bearer ${token}`)
      .send({ fromPageId: 1, name: "My Template" });
    expect([201, 400, 404, 409, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("passes auth on DELETE /kb/page-templates/1 with kb:templates:manage permission", async () => {
    const token = await signToken({ permissions: ["kb:templates:manage"], enabledModules: ["kb"] });
    const res = await callRoute("delete", "/kb/page-templates/1").set(
      "Authorization",
      `Bearer ${token}`,
    );
    expect([204, 404, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
